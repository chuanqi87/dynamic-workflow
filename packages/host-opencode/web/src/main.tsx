import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell.js";
import "./theme.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<AppShell />);
