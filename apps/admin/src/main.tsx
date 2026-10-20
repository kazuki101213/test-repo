import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './responsive.css';
import './adminTasks.css';
import './registrationFields.css';
import './registrationLayouts.css';
import App from './App';
import PasswordSetup from './components/PasswordSetup';

// Capture the invite/recovery route before the auth SDK consumes the URL fragment.
document.title = '管理アプリ';
const setup = new URLSearchParams(location.search).get('setup') === '1'
  || ['invite', 'recovery'].includes(new URLSearchParams(location.hash.slice(1)).get('type') ?? '');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {setup ? <PasswordSetup /> : <App />}
  </React.StrictMode>,
);
