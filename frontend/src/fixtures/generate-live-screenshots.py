"""Diagnostic camera crops only; never overwrite reference images or infer XYZ."""
import hashlib
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
SOURCE = Path('/home/betoche/Downloads/Telegram Desktop')
SHOTS = {
    '12': {'crop': [48, 560, 543, 1055], 'objects': [
        [[24, 121], [158, 121], [164, 398], [24, 399]],
        [[268, 49], [355, 85], [300, 224], [212, 189]],
        [[333, 157], [419, 194], [363, 329], [272, 294]],
        [[229, 303], [373, 361], [330, 450], [188, 392]],
    ]},
    '14': {'crop': [48, 560, 543, 1055], 'objects': [
        [[0, 0], [48, 0], [21, 495], [0, 495]],
    ]},
    '16': {'crop': [48, 422, 543, 918], 'objects': [
        [[90, 49], [163, 80], [119, 200], [39, 169]],
        [[180, 56], [265, 55], [269, 189], [181, 191]],
        [[291, 89], [379, 90], [378, 224], [292, 223]],
        [[117, 314], [349, 348], [336, 463], [100, 430]],
        [[422, 176], [495, 169], [495, 491], [470, 496]],
    ]},
}

for suffix, draft in SHOTS.items():
    source = SOURCE / f'photo_2026-10-14_01-41-{suffix}.jpg'
    raw = source.read_bytes()
    with Image.open(source) as image:
        crop = image.crop(draft['crop']).convert('RGBA')
        name = f'live-screenshot-{suffix}'
        crop.save(ROOT / f'{name}.png')
        metadata = {
            'sourceName': source.name,
            'sourceSha256': hashlib.sha256(raw).hexdigest(),
            'sourceSize': list(image.size),
            'cameraCrop': draft['crop'],
            'size': list(crop.size),
            'pixelSha256': hashlib.sha256(crop.tobytes()).hexdigest(),
            'annotationAuthor': 'AI draft',
            'humanConfirmed': False,
            'physicalBandCount': None,
            'physicalColorTruth': False,
            'uncertainty': 'Approximate object outlines; hidden edges and physical band count are unknown. Screenshot 14 contains old preview outlines, not ground truth. JPEG camera ROI is diagnostic encoded RGB only; no ICC calibration or reference XYZ.',
            'objectExclusions': draft['objects'],
        }
        (ROOT / f'{name}.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(json.dumps({'fixture': name, 'sourceSize': image.size, 'cropSize': crop.size}))
