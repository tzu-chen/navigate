import React from 'react';
import ReactDOM from 'react-dom/client';
import { MathJaxContext } from 'better-react-mathjax';
import App from './App';
import { KeybindingsProvider } from './contexts/KeybindingsContext';
import './styles/monolith-theme.css';
import './styles/main.css';

const mathJaxConfig = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MathJaxContext config={mathJaxConfig}>
      <KeybindingsProvider>
        <App />
      </KeybindingsProvider>
    </MathJaxContext>
  </React.StrictMode>
);
