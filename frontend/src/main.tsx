import { createRoot } from 'react-dom/client';
import { App } from './App';
import { consumeJoin } from './session';
import './styles.css';

// Consume and scrub fragment secrets before React, network activity or telemetry.
const initialJoin = consumeJoin(new URL(window.location.href), path => window.history.replaceState(null, '', path));
createRoot(document.getElementById('root')!).render(<App initialJoin={initialJoin} />);
