# Sites TPE/PME français avec formulaires de qualification substantiels

Objectif : dataset de référence pour entraîner / tester un générateur d'agent IA conversationnel en marque blanche, dont le rôle est d'analyser un site et de produire un agent qui qualifie un prospect en remplissant les champs du formulaire existant.

Critère d'inclusion : formulaire qui va au-delà d'un simple contact (nom / email / message), avec au minimum 7-10 champs incluant des informations qualifiantes spécifiques au métier (type de projet, surface, budget, prestations, dates, etc.).

Légende :
- **[V]** = form vérifié par fetch HTML, richesse confirmée
- **[P]** = page identifiée et confirmée par recherche, contenu du form à valider en live

---

## Tier 1 — Forms vérifiés

### 1. ILB Story — Photographe de mariage [V]

- **URL form** : https://www.ilbstory.com/devis-photographe-mariage-lyon.html
- **Verticale** : photographe mariage indépendant
- **Localisation** : Lyon
- **Style UI** : photographique artistique, élégant, registre mariage romantique
- **Champs typiques** : prénoms des mariés, date du mariage, lieu cérémonie, lieu réception, nombre d'invités, formule, prestations (préparatifs / cérémonie / soirée), email, tél, message
- **Pourquoi pertinent** : qualification événement précise, vocabulaire mariage, prestations modulaires

### 2. Les Ateliers du Bois — Artisan menuisier / cuisiniste [V] (site de référence)

- **URL form** : https://www.les-ateliers-du-bois.fr/artisan-cuisiniste-91/ (ancre `#devis`)
- **Verticale** : menuiserie sur-mesure indépendante
- **Localisation** : La Ferté-Alais, Essonne (91)
- **Style UI** : artisan bois chaleureux, fond blanc, photos d'atelier, logo "A" bleu cobalt `#035B9F`
- **Champs vérifiés (10)** : type de projet (radio 9 options : Dressing / Cuisine / Meuble d'entrée / Meuble sous escalier / Meuble TV / Bibliothèque / Aménagement garage / Aménagement bureau / Autre), prénom, nom, email, tél, code postal, ville, projet (textarea), upload documents (jpg/png/pdf 3 Mo)
- **Pourquoi pertinent** : qualification par type de projet en radio, vocabulaire menuiserie, upload de plans

### 3. Habitat Concept — Constructeur maison individuelle [V]

- **URL form** : https://www.habitatconcept.fr/devis
- **Verticale** : constructeur maison régional
- **Localisation** : moitié nord de la France (24 agences en Normandie / Nord / Picardie / Bretagne)
- **Style UI** : corporate régional grand public, bleu navy `#174e7d` + blanc, photos maisons modernes, sans-serif neutre, pavés explicatifs
- **Champs vérifiés (~10)** : type de maison (radio 4 options : plain-pied / hors d'eau hors d'air / combles aménagés / combles aménageables), garage (oui/non), nom, agence (dropdown 24 villes), téléphone, email, demande (textarea), souhait visio (oui/non), opt-in marketing groupe BDL
- **Pourquoi pertinent** : sélection d'agence locale, configuration technique du bien, classique BTP régional

### 4. Jardin-Rêve — Bureau d'études éco-paysager [V] ★ form le plus riche

- **URL form** : https://www.jardin-reve.fr/demande-devis.php
- **Verticale** : paysagiste écologique indépendant (fondatrice Béatrice Bourgery)
- **Localisation** : Muizon (51), interventions France entière + francophonie
- **Style UI** : nature douce, vert / beige, photographies de jardins, ton bienveillant et engagé écologie, papillon en mascotte
- **Champs vérifiés (~20)** : prénom, nom, email + confirmation, tél, adresse du jardin, pays jardin (dropdown ~90 pays), même adresse postale (oui/non conditionnel), adresse postale alternative + pays, surface estimée (m²), **choix d'une offre** (radio visuel 7 options : Oasis Urbaine / Eden Gourmand / Écrin Végétal / Havre Sauvage / Équilibre Feng Shui / Signature Végétale / Autres besoins), **choix d'un pack** (radio visuel 3 options : Essentiel / Immersif / Signature), options souhaitées (multi), **description projet** (textarea avec 6 questions guidantes : ressenti souhaité, usage principal, styles inspirants, contraintes, rêves, contraintes terrain), newsletter (oui/non), code promo, comment connu (radio 6 options), honeypot
- **Pourquoi pertinent** : exemple gold-standard de qualification en profondeur, avec sélecteurs visuels d'offre / pack, et un textarea guidé par questions ouvertes (excellent pour un agent IA conversationnel qui va naturellement les poser une par une)

### 5. Akena Vérandas — Vérandaliste, pergoliste, carportiste [V]

- **URL form** : https://www.akena.com/demande-de-devis
- **Verticale** : véranda / extension / pergola / carport / pool-house / abri piscine sur-mesure
- **Localisation** : Dompierre-sur-Yon (Vendée 85), réseau d'agences France entière + BE/CH/ES/IT
- **Style UI** : corporate moderne aluminium, blanc + accents couleur, photos pleine largeur, ton commercial pro
- **Champs vérifiés (~10)** : nom, prénom, email, téléphone, adresse, code postal, ville, pays (dropdown 9 pays), **produit qui intéresse** (dropdown 12 options : Véranda / Extension / Pergola-Préau / Carport / Carport solaire / Pool-house / Abri piscine / Véranda piscine / Sas d'entrée / Stores véranda / Stores pergola / Panneaux solaires), message (textarea), opt-in marketing, RGPD
- **Pourquoi pertinent** : qualification produit par grand dropdown 12 options, intent commerciale claire

---

## Tier 2 — Pages identifiées, à vérifier en live

### 6. Piscinelle — Pisciniste haut de gamme [P]

- **URL form** : https://www.piscinelle.com (chercher "Configurateur" ou "Demander un devis")
- **Verticale** : piscine en kit haut de gamme et sur-mesure
- **Localisation** : Normandie (Oise, Orne, Manche, Calvados)
- **Style UI attendu** : luxe accessible, photos de piscines design, ton "intemporel haut de gamme"
- **Champs attendus** : dimensions piscine (longueur / largeur / profondeur), modèle, finition (mosaïque / liner / coque), accessoires (margelles, escalier, banquette, volet automatique), localisation, projet en cours / à venir, contact, budget
- **Pourquoi pertinent** : configurateur produit = qualification très technique, prix qui dépend des choix

### 7. Voyageurs du Monde — Voyagiste sur-mesure [P]

- **URL form** : https://www.voyageursdumonde.fr/voyage-sur-mesure/demandedevis/demandedevisopti1
- **Verticale** : voyage sur-mesure premium éditorial
- **Style UI** : magazine de voyage, palette terre / crème / sépia, typo sérif élégante, photos pleine page
- **Champs attendus** : destination(s), période, durée, nombre de voyageurs (adultes + enfants avec âges), type d'hébergement, centres d'intérêt, niveau de confort, budget par personne, déjà voyagé avec eux, comment connu, contact, message
- **Pourquoi pertinent** : qualification émotionnelle + logistique très riche, vocabulaire éditorial
- **Note** : page rendue en SPA JS, non fetchable en HTML brut — à valider via Chrome

### 8. CAFPI — Courtier prêt immobilier [P]

- **URL form** : https://www.cafpi.fr (parcours simulation + RDV courtier)
- **Verticale** : courtage en crédit immobilier
- **Style UI** : corporate financier institutionnel, bleu navy + blanc, sans-serif neutre, ton réassurant chiffré
- **Champs attendus** : type de projet (achat / renégo / rachat), type de bien (neuf / ancien / VEFA / terrain), prix du bien, apport, situation pro de chaque emprunteur (CDI / CDD / TNS / fonctionnaire), revenus mensuels par emprunteur, charges, enfants à charge, situation familiale, département, durée souhaitée, déjà propriétaire, contact (~20-25 champs sur plusieurs étapes)
- **Pourquoi pertinent** : qualification B2C financière très réglementée, vocabulaire bancaire

### 9. Squirrel Mariage Film — Vidéaste mariage [P]

- **URL form** : https://squirrelfilm.fr/contact/
- **Verticale** : vidéaste mariage indépendant
- **Style UI** : créatif cinéma, vidéos d'arrière-plan, fond noir / blanc, typo dynamique
- **Grille tarifaire visible (5 forfaits + 13 options)** : Cérémonie 990€ / Demi-journée 1490€ / Classique 2200€ / Week-end 3800€ / Photo+Vidéo 4800€. Options : soirée, drone, interviews, étalonnage, heures sup, teaser Instagram, séance couple, cérémonie 2 caméras, EVG/EVJF, second cadreur, livre d'or audio.
- **Champs attendus** : date mariage, lieu(x), forfait souhaité, options A et B, recommandation (remise 5%), prénoms, email, tél, message
- **Pourquoi pertinent** : matrice forfait × options très combinatoire (= excellent test pour un agent qui doit guider)

### 10. Notes de Styles — Architecte d'intérieur [P]

- **URL form** : https://www.notesdestyles.com (page contact / devis)
- **Verticale** : agence d'architecture d'intérieur réseau national
- **Style UI** : décoration intérieure haut de gamme, photos d'intérieurs léchées, palette épurée beige / blanc / noir
- **Champs attendus** : type de bien (maison / appartement), surface, pièces concernées, type de travaux (rénovation complète / aménagement / décoration), style souhaité, budget, délai, localisation, photos / plans, contact
- **Pourquoi pertinent** : qualification déco précise, brief créatif, style premium éditorial

---

## Pistes complémentaires non explorées

Pour étendre le dataset, verticales avec forms typiquement chargés en France à fouiller :
- Wedding planner haut de gamme (Justine Huette, Mariage dans l'air)
- Photographe pro corporate (réseaux indépendants)
- Loueur tente / matériel événementiel
- Société de naturopathie / médecine douce
- Cabinet recrutement cadres (Robert Half, Michael Page indé)
- Maître d'œuvre / contracteur général rénovation lourde
- Loueur voitures de luxe longue durée
- Imprimerie offset / packaging sur-mesure
- Société de toilettage / pension canine premium
- Décorateur d'extérieur / piscine designer indé

## Méta : ce que ce dataset doit permettre au générateur d'agent

En croisant ces 10 sites, un générateur d'agent IA doit pouvoir gérer :

1. **Variété de verticales** : événementiel, BTP, paysagisme, voyage, finance, vidéo, déco — chacune avec son vocabulaire propre.
2. **Variété de styles UI** : du chaleureux artisan (Ateliers du Bois) au corporate financier (CAFPI), du créatif cinéma (Squirrel) au magazine éditorial (Voyageurs du Monde) — l'agent généré doit hériter de cette identité.
3. **Variété de champs** : du dropdown produit simple (Akena) au sélecteur visuel d'offre + pack (Jardin-Rêve), du textarea libre à la textarea guidée par questions, en passant par les uploads de plans/photos.
4. **Variété de tons** : tutoiement décalé (Squirrel) vs vouvoiement institutionnel (Habitat Concept, CAFPI) vs vouvoiement chaleureux (Ateliers du Bois, Jardin-Rêve) vs vouvoiement éditorial (Voyageurs du Monde).
5. **Variété de longueurs** : 10 champs simples (Akena) vs 20+ champs avec branches conditionnelles (Jardin-Rêve, CAFPI).

Un agent qui gère bien ces 10 cas devrait extrapoler proprement à n'importe quelle TPE/PME française avec un formulaire de qualification.
