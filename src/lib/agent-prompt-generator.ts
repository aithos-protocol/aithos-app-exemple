// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Business + Formulaire JSON → System prompt for a prospect-qualification agent.
//
// Given:
//   - a paragraph describing the business (mission, audience, tone)
//   - a JSON contract describing the form fields the business collects
//     from prospects (name, email, company, use-case, budget, etc.)
//
// Ask Claude Sonnet 4.6 (text mode) to produce the SYSTEM PROMPT of a
// conversational agent whose mission is to QUALIFY incoming prospects:
// listen, gently steer the conversation toward the data the business
// needs, and emit a structured JSON payload at the end. The output
// system prompt is a complete, ready-to-deploy prompt — not a meta
// description of one.

import type { AithosSDK } from "@aithos/sdk";

import type { FormulaireSchema } from "./url-analyzer.js";

export interface AgentPromptResult {
  /** The generated system prompt, ready to plug into another invokeBedrock call. */
  readonly systemPrompt: string;
  /** Sonnet's short rationale (why this framing). */
  readonly reasoning: string;
  /** Raw assistant content (for debugging). */
  readonly rawContent: string;
  /** Microcredits spent. */
  readonly creditsSpent: number;
}

const SYSTEM_PROMPT = [
  "Tu es un prompt-engineer spécialisé dans les agents conversationnels",
  "B2B / B2C de qualification de prospects.",
  "",
  "On va te donner :",
  "  1. Une description en français d'une entreprise (`business`).",
  "  2. Un schéma JSON décrivant les formulaires que cette entreprise",
  "     utilise pour collecter les informations de ses prospects",
  "     (`formulaire`).",
  "",
  "Ta mission : produire le PROMPT SYSTÈME COMPLET d'un agent",
  "conversationnel dont le rôle est de QUALIFIER les visiteurs/prospects",
  "de cette entreprise. Cet agent doit :",
  "  - se présenter au nom de l'entreprise (utilise le ton du business),",
  "  - écouter le besoin du prospect,",
  "  - le guider naturellement, par questions ouvertes puis fermées,",
  "    pour obtenir TOUTES les informations listées dans le formulaire,",
  "  - reformuler en synthèse à la fin,",
  "  - émettre, en tout dernier message, UN objet JSON structuré qui",
  "    correspond exactement au schéma du formulaire (mêmes noms de",
  "    champs, mêmes types).",
  "",
  "Le prompt système que tu produis DOIT contenir, dans cet ordre :",
  "  - RÔLE : qui est l'agent, au nom de quelle entreprise il parle.",
  "  - MISSION : ce qu'il cherche à obtenir (qualification).",
  "  - TON : adapté au business fourni (sérieux / playful / technique…).",
  "  - DONNÉES À COLLECTER : reformule chaque champ du formulaire en",
  "    une ligne lisible (label, requis ou non, exemple de question",
  "    naturelle pour l'obtenir). N'utilise PAS de tableau JSON ici —",
  "    rédige en bullet points lisibles.",
  "  - RÈGLES DE CONDUITE : poser une question à la fois, ne pas",
  "    demander toutes les infos d'un coup, accepter les réponses",
  "    partielles, gérer les digressions sans perdre le fil, ne JAMAIS",
  "     inventer de réponse à la place du prospect.",
  "  - FORMAT DE SORTIE : décris explicitement le JSON final attendu",
  "    (clés exactes, types). Utilise un bloc ```json``` pour montrer",
  "    le schéma exact à respecter. L'agent doit l'émettre uniquement",
  "    en TOUT DERNIER message, après la synthèse, et après accord du",
  "    prospect sur la synthèse.",
  "  - GARDE-FOUS : refuser poliment toute demande hors-sujet ; si",
  "    le prospect demande à parler à un humain, répondre que la",
  "    demande sera transmise.",
  "",
  "RÈGLES STRICTES sur ta sortie :",
  "- Le prompt système que tu produis doit être REUTILISABLE TEL QUEL,",
  "  pas une description en surplomb. Il doit s'adresser à l'agent à la",
  "  deuxième personne (\"Tu es… Ta mission est…\").",
  "- Tout doit être en FRANÇAIS (sauf les noms de champs JSON qui",
  "  restent tels que dans le schéma fourni).",
  "- Pas d'introduction style \"Voici le prompt :\" — le prompt commence",
  "  directement.",
  "",
  "FORMAT DE TA RÉPONSE — JSON unique, pas de markdown, pas de fence :",
  "{",
  '  "systemPrompt": "<le prompt système complet, en plusieurs paragraphes, prêt à l\'emploi>",',
  '  "reasoning": "<2-3 phrases : choix de ton, ordre de questions, particularités>"',
  "}",
].join("\n");

const USER_PROMPT_PREFIX = [
  "Voici les inputs.",
  "",
  "BUSINESS (paragraphe) :",
  "",
].join("\n");

/**
 * Generate the system prompt of a prospect-qualification agent from a
 * business description + the form schema the business collects.
 *
 * Throws if `business` is too short, the formulaire has no fields, or
 * the SDK call fails.
 */
export async function generateAgentSystemPrompt(args: {
  readonly sdk: AithosSDK;
  readonly business: string;
  readonly formulaire: FormulaireSchema;
}): Promise<AgentPromptResult> {
  const { sdk, business, formulaire } = args;

  if (business.trim().length < 20) {
    throw new Error(
      "business description is too short — please write at least a couple of sentences",
    );
  }
  const totalFields = formulaire.forms.reduce(
    (sum, f) => sum + f.fields.length,
    0,
  );
  if (totalFields === 0) {
    throw new Error(
      "formulaire is empty — add at least one form with one field, or run the URL analyzer first",
    );
  }

  const userPrompt =
    USER_PROMPT_PREFIX +
    business.trim() +
    "\n\nFORMULAIRE (JSON) :\n\n" +
    JSON.stringify(formulaire, null, 2) +
    "\n\nProduis le JSON `{systemPrompt, reasoning}` demandé.";

  console.log("[agent-prompt-generator] calling Sonnet 4.6 (text)…");
  const t0 = performance.now();
  const r = await sdk.compute.invokeBedrock({
    model: "claude-sonnet-4-6",
    system: SYSTEM_PROMPT,
    // Bumped to 8000 (Sonnet 4.6 max output is 8192). The generated
    // systemPrompt for verbose business descriptions can run >8000
    // chars on its own, and the old 3000-token cap was truncating
    // the JSON mid-string ("Unterminated string at position 8829").
    maxTokens: 8000,
    messages: [{ role: "user", content: userPrompt }],
  });
  console.log(
    `[agent-prompt-generator] Sonnet returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
  );

  const parsed = parseAgentJson(r.content);
  return {
    systemPrompt: parsed.systemPrompt,
    reasoning: parsed.reasoning,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
  };
}

function parseAgentJson(content: string): {
  systemPrompt: string;
  reasoning: string;
} {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const json = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Sonnet returned malformed JSON: ${(e as Error).message}. Content: ${json.slice(0, 200)}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet JSON is not an object");
  }
  const r = obj as Record<string, unknown>;
  if (typeof r.systemPrompt !== "string" || r.systemPrompt.trim().length === 0) {
    throw new Error("Sonnet JSON: systemPrompt missing or empty");
  }
  return {
    systemPrompt: r.systemPrompt.trim(),
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
  };
}
