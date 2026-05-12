# Analyse — Les Ateliers du Bois

**URL de référence** : https://www.les-ateliers-du-bois.fr/artisan-cuisiniste-91/
**Objectif** : servir de brief pour générer un agent IA conversationnel en marque blanche, cohérent avec le design et l'esprit du site, capable de qualifier un prospect via les champs du formulaire existant.

---

## 1. Synthèse du site

**Activité** : artisan menuisier-cuisiniste indépendant, fabricant et poseur, installé depuis 1994 à La Ferté-Alais en Essonne (91). Plus de 6 000 clients satisfaits, garantie 10 ans, fabrication française.

**Périmètre produit** : cuisines sur-mesure (cœur de l'offre vitrine), dressings, meubles d'entrée, meubles sous escalier, meubles TV, bibliothèques, aménagements pour bureau / garage, escaliers, parquets, fenêtres / baies vitrées / portes d'entrée / portails / volets / portes de garage en bois, alu, PVC, abris de jardin, pergolas, terrasses. C'est en réalité un menuisier généraliste haut de gamme qui couvre toute la maison, mais qui se met en avant comme **artisan cuisiniste local**.

**Positionnement** : qualité, durabilité, proximité, expertise transmise. "La vraie cuisine sur-mesure", "fabriquée localement", "un agenceur spécialisé se déplace à votre domicile". Promesse de paiement échelonné en 12 fois, devis gratuit et sans engagement, conseiller dédié nommé ("Karine vous contactera").

**Argumentaires récurrents** : 30 ans d'expérience, fabrication en France et plus précisément en Essonne, label NF, garantie décennale, SAV de proximité, infinité de styles et finitions, atelier moderne, savoir-faire transmis.

## 2. Formulaire de qualification (cible de l'agent)

Champs présents (~10) :

- **Type de projet** (radio, 9 options) : Dressing / Cuisine / Meuble d'entrée / Meuble sous escalier / Meuble TV / Bibliothèque - Étagère / Aménagement de garage / Aménagement pour bureau / Un autre projet
- **Prénom**
- **Nom** (requis)
- **Adresse e-mail** (requis)
- **Téléphone** (requis, "indispensable pour convenir d'un RDV")
- **Code postal** (requis)
- **Ville** (requis, "la ville où se dérouleront vos travaux")
- **Votre projet** (textarea libre)
- **Pièces jointes** (jpg, jpeg, png, gif, pdf, 3 Mo max — plans, photos, etc.)
- Honeypot anti-spam

L'agent IA devra collecter ces mêmes informations en discussion naturelle, en s'adaptant à l'option choisie (vocabulaire cuisine ≠ vocabulaire dressing) et en relançant pour les pièces jointes optionnelles.

## 3. Univers graphique

**Couleur de fond dominante** : blanc pur (`#ffffff` confirmé en `theme-color`). Les sections de contenu alternent blanc cassé et blocs photographiques pleine largeur. Aucun fond foncé, aucun dégradé saturé.

**Couleur de marque (logo)** : bleu corporate franc et saturé, mesuré à `#035B9F` sur le logo (tirant vers le bleu cobalt / bleu de France). Le logo est un grand "A" majuscule géométrique qui évoque à la fois une lettre, un toit d'atelier et une équerre, avec la baseline "ATELIERS DU BOIS" intégrée à l'intérieur du A. Aucun bois apparent dans l'identité de marque elle-même — le contraste est volontaire entre une marque "bleu industriel sérieux" et un contenu "bois chaud artisanal".

**Palette d'accent** : tonalités bois chaud (brun-noisette, miel, chêne clair) issues principalement des photos de réalisations, et non du chrome de l'interface. Le bleu `#035B9F` du logo se retrouve probablement sur certains CTA, liens et accents. Les zones de texte sur fond blanc utilisent du gris anthracite à noir pour les titres.

**Logo** : fichier joint `ateliers-du-bois-logo.png` (extrait à partir du SVG officiel `Logo_ADB-1-1-2.svg` du site, rendu 2312×1506 px, fond transparent).

**Typographie** : sans-serif géométrique standard, hiérarchie classique (gros titres en lettres droites, sous-titres maigres, paragraphes confortables). Aucune typo display, aucune fioriture script ou italique romantique. Ton "menuisier sérieux qui sait lire un devis".

**Photographie** : photos réelles de cuisines posées chez des clients, plans serrés sur des plans de travail, façades de meuble, finitions, parfois un artisan en train de travailler. Lumière naturelle, intérieurs habités, ambiance "maison familiale" plutôt que showroom de luxe. Pas d'images stock léchées, pas de rendus 3D.

**Pictos et logos** : logos statiques en image (label "Fabriqué en France" tricolore, label NF, AvisVérifiés avec étoiles, bannière promo "12X" en couleurs vives ponctuelles). Pas d'illustrations vectorielles ni d'animations.

**Template général** : structure WordPress + Elementor / Slider Revolution classique, en colonnes simples, large mega-menu déroulant qui liste toutes les sous-gammes (fenêtres alu / PVC / bois, etc.), bandeaux pleine largeur photo + texte centré, sections témoignages, CTA récurrents "Demander un devis gratuit" en boutons rectangulaires. UI fonctionnelle, ni moderne ni datée, conçue pour rassurer un particulier qui prépare un projet de plusieurs milliers d'euros.

## 4. Univers sémantique et émotionnel

**Ton** : tutoiement absent, vouvoiement chaleureux mais sérieux. "Profitez au quotidien", "Laissez libre cours à votre imagination", "Nous le réalisons et le posons pour vous". Vocabulaire de l'artisanat : atelier, agenceur, savoir-faire, pose, finitions, sur-mesure, fabrication, garantie, SAV.

**Valeurs projetées** : confiance, durabilité, transmission, fabrication française, proximité géographique, conseil humain, sérieux financier (paiement échelonné).

**Cible implicite** : propriétaires d'une maison ou d'un appartement en Essonne (CSP+, 35-65 ans), qui préparent une rénovation et préfèrent un artisan local à un Ikea ou Schmidt.

## 5. Recommandation pour le prompt de l'image du robot

Pour que l'agent IA "matche" le site, il faut **éviter absolument** : l'esthétique sci-fi métallique brillante, les LED bleues / cyan, les visages androïdes blancs lisses, les écrans holographiques, le néon, l'aspect Tesla / Boston Dynamics.

Il faut **viser** : un robot fait main, en bois clair tourné ou sculpté, articulé comme un pantin d'atelier ou une marionnette de menuisier, fini à la main avec des assemblages visibles (queues d'aronde, tenons-mortaises, vis laiton apparentes), posé sur un établi avec copeaux. Lumière naturelle latérale d'atelier, fond crème ou bois clair. Expression bienveillante, posture serviable (légèrement penché vers l'utilisateur), proportions un peu trapues et rassurantes, pas filiformes.

**Touche d'identité de marque** : intégrer le bleu `#035B9F` du logo comme accent ciblé — par exemple un tablier de menuisier en toile bleue cobalt, un bandana ou casquette bleu, le manche d'un outil tenu par le robot, ou les "yeux" du robot (sans LED, juste de la peinture mate bleue). Le bleu ne doit pas dominer, juste signer le robot comme appartenant à l'univers Ateliers du Bois.

### Prompt prêt à coller (Midjourney / DALL-E / Imagen)

```
A friendly handcrafted wooden robot artisan, made of warm light oak and beech
wood, visible dovetail and mortise-and-tenon joinery, exposed brass screws and
hinges, wearing a small cobalt blue (#035B9F) canvas apron with a single chest
pocket holding a folding ruler, posture slightly leaning forward in a helpful
gesture, soft warm smile carved into its face, eyes painted matte cobalt blue,
standing on a clean wooden workbench with a few wood shavings around, soft
natural side light from a workshop window, cream and honey-wood color palette
with a single cobalt blue accent matching the Ateliers du Bois brand, no metal
sheen, no glowing LEDs, no neon, no futuristic chrome, French artisan workshop
atmosphere, photographic realism, shallow depth of field, advertising
photography aesthetic, 3:4 vertical composition.
```

### Negative prompt

```
chrome, metallic, sci-fi, futuristic, glowing eyes, LED, neon, blue accents,
cold lighting, plastic, android, humanoid face, cyberpunk, dystopian.
```

### Variations à tester

- **Variation Pinocchio minimaliste** : robot en bois plus stylisé, traits épurés, à la manière d'un jouet de créateur scandinave, fond crème uni.
- **Variation compagnon de cuisine** : robot posé sur un plan de travail en chêne au milieu d'une cuisine équipée chaleureuse, en arrière-plan flou.
- **Variation outil anthropomorphe** : robot dont le corps évoque des outils de menuisier (manche de ciseau à bois, tête d'équerre), plus métaphorique.

## 6. Cohérence chat UI

Pour aller jusqu'au bout de la cohérence, le widget de chat sur ce site devrait :

- Fond blanc cassé `#fafaf7` ou crème léger, jamais sombre.
- Bulles utilisateur en bois clair / beige, bulles agent en blanc avec liseré bleu marque (`#035B9F`).
- Boutons de relance (CTA, quick replies) en bleu `#035B9F` plein, texte blanc.
- Typo identique au site (sans-serif standard), pas de monospace ni de display.
- Avatar : le robot bois généré ci-dessus, en miniature ronde sur fond crème.
- Header du widget : logo "A" Ateliers du Bois en bleu sur fond blanc, à gauche du nom de l'assistant.
- Ton de l'agent : vouvoiement, posé, terminologie "atelier / sur-mesure / réalisation / pose / agenceur", pas de jargon tech.
- Premier message type : "Bonjour, je suis l'assistant des Ateliers du Bois. Je peux vous aider à préparer votre projet (cuisine, dressing, escalier…) pour qu'un de nos agenceurs vous rappelle avec un premier chiffrage. On commence ?"
