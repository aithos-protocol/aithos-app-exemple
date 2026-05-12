// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// URL → brand description.
//
// Given the URL of a website / product / business, ask Claude (via
// the SDK's `invokeUrlFetch`, which routes through Anthropic's
// `web_fetch` server-side tool) to fetch the page and produce a
// paragraph-length description suitable for pasting into the
// "Describe the brand" textarea of the design-agent.
//
// The description targets a brand-mascot art director (= the
// design-agent's role): mission, audience, tone, graphic style. The
// agent must AVOID framing/composition instructions and chest
// references (those are owned downstream).

import type { AithosSDK } from "@aithos/sdk";

export interface UrlAnalysis {
  /** The paragraph-length brand description, ready for the textarea. */
  readonly description: string;
  /** URLs Claude actually fetched (usually just the input, sometimes a few). */
  readonly urlsFetched: ReadonlyArray<{ readonly url: string; readonly title?: string }>;
  /** Citation spans linking phrases back to fetched documents. */
  readonly citations: ReadonlyArray<{ readonly url: string; readonly citedText: string }>;
  /** Microcredits debited. */
  readonly creditsSpent: number;
  /** Number of web_fetch tool invocations (= number of URLs fetched). */
  readonly webFetchInvocations: number;
}

const SYSTEM_PROMPT = [
  "Tu es un assistant de brand-research.",
  "",
  "On va te donner un URL. Ta tâche :",
  "  1. Fetche cette page (et seulement les pages /about, /qui-sommes-nous,",
  "     /a-propos, ou équivalent — max 3 URLs) pour comprendre la marque.",
  "  2. Identifie : le service ou produit, l'audience cible, le ton",
  "     (sérieux, playful, luxueux, industriel, technique, accessible…),",
  "     le style graphique global (couleurs dominantes que tu as vues,",
  "     ambiance, niveau de polish).",
  "  3. Rédige UN paragraphe de 6 à 10 phrases EN FRANÇAIS qui décrit",
  "     la marque, destiné à un brand-mascot art director qui va dessiner",
  "     un robot mascot représentant cette marque.",
  "",
  "Le paragraphe doit donner au designer assez d'information pour",
  "imaginer un robot qui matche la marque : mission, mood, palette",
  "approximative, type d'audience.",
  "",
  "Le paragraphe NE DOIT PAS contenir :",
  "- d'instructions de cadrage ou de composition (centred, square, halo,",
  "  framing, crop) — gérées par un système séparé.",
  "- de description de la poitrine, du pectoral, du chest, du sternum,",
  "  du breastplate, ou de tout autre élément lié au torse du robot —",
  "  un logo sera composé sur le torse par un système séparé, toute",
  "  description du torse interférerait avec ce processus.",
  "",
  "Réponds UNIQUEMENT avec le paragraphe descriptif, pas d'introduction,",
  "pas de markdown, pas de section, pas de bullet points. Du texte brut",
  "prêt à être collé dans un textarea.",
].join("\n");

/**
 * Fetch a URL via Anthropic's web_fetch and return a brand description
 * paragraph ready for the design-agent's textarea.
 *
 * Throws if the URL is malformed or if the SDK call fails.
 */
export async function analyzeUrl(
  sdk: AithosSDK,
  url: string,
): Promise<UrlAnalysis> {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(trimmed)) {
    throw new Error("URL must start with http:// or https:// and look like a real URL");
  }

  // Cast at the boundary: invokeUrlFetch landed in @aithos/sdk
  // alpha.20. The example app's installed version may still be
  // alpha.19 until `pnpm install` picks up the new release.
  const compute = sdk.compute as unknown as {
    invokeUrlFetch(args: {
      prompt: string;
      system?: string;
      model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
      maxTokens?: number;
      maxFetches?: number;
      maxContentTokens?: number;
      citations?: boolean;
      allowedDomains?: readonly string[];
      blockedDomains?: readonly string[];
    }): Promise<{
      content: string;
      citations: ReadonlyArray<{
        url: string;
        citedText: string;
        documentTitle?: string;
      }>;
      urlsFetched: ReadonlyArray<{ url: string; title?: string }>;
      usage: {
        inputTokens: number;
        outputTokens: number;
        webFetchInvocations: number;
      };
      creditsCharged: number;
    }>;
  };

  console.log("[url-analyzer] calling invokeUrlFetch on", trimmed);
  const t0 = performance.now();
  const r = await compute.invokeUrlFetch({
    prompt: `Voici l'URL à analyser :\n\n${trimmed}\n\nFetche cette page et rédige le paragraphe descriptif.`,
    system: SYSTEM_PROMPT,
    model: "claude-sonnet-4-6", // bon compromis vitesse / qualité pour de l'analyse web
    maxTokens: 1500,
    maxFetches: 3,
    maxContentTokens: 100_000,
    citations: true,
  });
  console.log(
    `[url-analyzer] returned in ${(performance.now() - t0).toFixed(0)}ms, ` +
    `${r.usage.webFetchInvocations} fetch(es), credits=${r.creditsCharged}`,
  );

  // The model is instructed to output ONLY the paragraph — strip any
  // accidental leading/trailing whitespace.
  const description = r.content.trim();

  return {
    description,
    urlsFetched: r.urlsFetched,
    citations: r.citations.map((c) => ({ url: c.url, citedText: c.citedText })),
    creditsSpent: r.creditsCharged,
    webFetchInvocations: r.usage.webFetchInvocations,
  };
}
