import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootTheme } from './themes';
import './styles.css';

// Before the first paint: the saved palette is mirrored in localStorage so the
// window does not open in the default and swap a frame later.
bootTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
