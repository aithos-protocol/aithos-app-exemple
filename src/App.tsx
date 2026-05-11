// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { Route, Routes } from "react-router-dom";

import { Nav } from "./components/Nav.js";
import { AuthCallback } from "./routes/AuthCallback.js";
import { Compute } from "./routes/Compute.js";
import { Home } from "./routes/Home.js";
import { Image } from "./routes/Image.js";
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
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/mandates" element={<Mandates />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/compute" element={<Compute />} />
          <Route path="/image" element={<Image />} />
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
