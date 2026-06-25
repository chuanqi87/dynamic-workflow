import React from "react";
import { createRoot } from "react-dom/client";

function App(): React.ReactElement {
  return <div data-testid="app-root">Workflow Dashboard</div>;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
