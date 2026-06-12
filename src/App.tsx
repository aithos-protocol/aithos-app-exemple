// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { Route, Routes } from "react-router-dom";

import { Nav } from "./components/Nav.js";
import { Agent } from "./routes/Agent.js";
import { Assets } from "./routes/Assets.js";
import { Compute } from "./routes/Compute.js";
import { AuthVerifyPage, ResetPage } from "./routes/Custodial.js";
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
          <Route path="/assets" element={<Assets />} />
          <Route path="/agent" element={<Agent />} />
          {/* Custodial email landings — these paths are the app's
              verify_base_url / reset_base_url in aithos-auth-apps. */}
          <Route path="/auth/verify" element={<AuthVerifyPage />} />
          <Route path="/reset" element={<ResetPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
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
