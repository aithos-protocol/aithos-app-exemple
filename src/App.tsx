// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { Route, Routes } from "react-router-dom";

import { Nav } from "./components/Nav.js";
import { Agent } from "./routes/Agent.js";
import { Compute } from "./routes/Compute.js";
import { DataPage } from "./routes/Data.js";
import { Home } from "./routes/Home.js";
import { Mandates } from "./routes/Mandates.js";
import { Profile } from "./routes/Profile.js";
import { Wallet } from "./routes/Wallet.js";

export function App() {
  return (
    <div className="app">
      <Nav />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/mandates" element={<Mandates />} />
          <Route path="/compute" element={<Compute />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/assets" element={<Stub name="Assets" />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

/** Temporary placeholder while each page is ported onto the actor model. */
function Stub({ name }: { readonly name: string }) {
  return (
    <section>
      <h2>{name}</h2>
      <p className="lede">Porting onto the single-actor model — coming next.</p>
    </section>
  );
}

function NotFound() {
  return (
    <section>
      <h2>404</h2>
      <p>Page not found.</p>
    </section>
  );
}
