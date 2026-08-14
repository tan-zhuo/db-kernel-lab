import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hideBootScreen } from './lib/boot-screen';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 兜底：即使引擎初始化异常，8 秒后也要把启动页撤掉（正常路径由 store.boot 触发）。
window.setTimeout(hideBootScreen, 8000);
