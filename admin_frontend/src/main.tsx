// FILE: ~/otmega/otmega_app/console/admin_frontend/src/main.tsx
// ماموریت: نقطه ورود React برای mount کردن Admin Console.

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/console.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
