import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthPage } from './HealthPage';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HealthPage />
  </StrictMode>,
);
