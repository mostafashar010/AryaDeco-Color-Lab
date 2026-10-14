"""Wait for a consented diagnostic image. Never copy or extend its retention."""
import json
import argparse
import os
import shutil
from pathlib import Path
import time
from watchfiles import watch


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,help='One explicitly requested private analysis copy; delete after review')
    args=parser.parse_args()
    directory=Path(__file__).resolve().parents[1]/"data/live-debug"
    if not directory.is_dir():
        raise SystemExit("Live debug directory is not available")
    def recent(path):
        try:
            return path.is_file() and path.suffix==".png" and time.time()-path.stat().st_mtime<30
        except OSError:
            return False
    def report(path):
        if args.snapshot:
            fd=os.open(args.snapshot,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
            with path.open('rb')as source,os.fdopen(fd,'wb')as target:
                shutil.copyfileobj(source,target)
            args.snapshot.chmod(0o600)
        print(json.dumps({'image':str(args.snapshot or path),'original':str(path),'retention':'temporary-explicit-analysis-copy' if args.snapshot else 'original-five-minute-window'}),flush=True)
    existing=[path for path in directory.glob("*/*.png") if recent(path)]
    if existing:
        path=max(existing,key=lambda item:item.stat().st_mtime)
        report(path)
        return
    for changes in watch(directory,recursive=True,debounce=150):
        for _,name in sorted(changes):
            path=Path(name)
            if recent(path):
                report(path)
                return


if __name__=="__main__":
    main()
