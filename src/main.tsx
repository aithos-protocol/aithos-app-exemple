// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import { SdkProvider } from "./sdk-context.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SdkProvider>
        <App />
      </SdkProvider>
    </BrowserRouter>
  </StrictMode>,
);
