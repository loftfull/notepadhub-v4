import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import App from "./App";
import { loadFromHost, HostSync } from "./hostAdapter";
import { installAiTransport } from "./aiTransport";
import "@mantine/core/styles.css";
import "@blocknote/mantine/style.css";
import "./styles.css";
import "./design-system.css";
import "./ai-assistant.css";
import "./layout-v4.css";
import "./ai-studio.css";
import "./print.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

function Failure({ message }: { message: string }) {
  return (
    <div role="alert" style={{ font: "16px/1.6 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif", maxWidth: 640, margin: "12vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Не удалось открыть библиотеку</h1>
      <p>{message}</p>
      <p>Данные не изменены. Закройте другие окна Notepad Hub и повторите.</p>
      <button onClick={() => location.reload()} style={{ font: "inherit", padding: "8px 16px" }}>Повторить</button>
    </div>
  );
}

async function start() {
  installAiTransport();
  try {
    const loaded = await loadFromHost();
    const sync = new HostSync(loaded);
    root.render(
      <React.StrictMode>
        <MantineProvider>
          <App initial={loaded} sync={sync} />
        </MantineProvider>
      </React.StrictMode>,
    );
  } catch (error) {
    root.render(<Failure message={error instanceof Error ? error.message : "Неизвестная ошибка хоста"} />);
  }
}

void start();

