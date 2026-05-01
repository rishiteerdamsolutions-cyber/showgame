/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production Socket.IO origin, e.g. https://your-api.onrender.com */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
