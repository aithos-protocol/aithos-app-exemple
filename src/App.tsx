// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { Route, Routes } from "react-router-dom";

import { Nav } from "./components/Nav.js";
import { Assets } from "./routes/Assets.js";
import { AuthCallback } from "./routes/AuthCallback.js";
import { AcceptInvite } from "./routes/AcceptInvite.js";
import { Compute } from "./routes/Compute.js";
import { Data } from "./routes/Data.js";
import { DelegateData } from "./routes/DelegateData.js";
import { Home } from "./routes/Home.js";
import { Mandates } from "./routes/Mandates.js";
import { Profile } from "./routes/Profile.js";
import { ResetPassword } from "./routes/ResetPassword.js";
import { VerifyEmail } from "./routes/VerifyEmail.js";
import { Wallet } from "./routes/Wallet.js";

export function App() {
  return (
    <div className="app">
      <Nav />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/auth/reset" element={<ResetPassword />} />
          <Route path="/auth/verify" element={<VerifyEmail />} />
          <Route path="/auth/invite" element={<AcceptInvite />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/mandates" element={<Mandates />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/compute" element={<Compute />} />
          <Route path="/data" element={<Data />} />
          <Route path="/delegate-data" element={<DelegateData />} />
          <Route path="/assets" element={<Assets />} />
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
