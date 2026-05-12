# Piscinelle

**URL** : https://www.piscinelle.com
**URL form / configurateur** : https://www.piscinelle.com/en/prices

## Activité

Piscinelle est un fabricant français de piscines haut de gamme installé en Normandie depuis 1979. L'entreprise conçoit et produit des piscines bois sur-mesure, livrées en kit, à monter soi-même ou avec l'aide d'un installateur partenaire. Le positionnement est clairement premium et "design" : piscines "à l'émotion esthétique", écoconçues, plusieurs fois primées (Piscinelle Gold awards), avec une promesse de personnalisation quasi illimitée (forme, dimensions, finitions, équipements).

La marque couvre la France entière via un réseau de conseillers régionaux (Normandie, Oise, Orne, Manche, Calvados et au-delà), avec catalogue papier gratuit, prise de rendez-vous en ligne, magazine de marque et store. Gamme structurée par modèles : Cr (rectangulaire), Bo (carrée), Cn (couloir de nage), Iki (XS), Or (proportions divines), Ds (galbée). Tarification publique et configurateur en ligne — fait rare sur ce marché — affichent une volonté de transparence (avis Verified Reviews).

## Style UI / palette

- **Couleur dominante de marque** : `#E2007A` (magenta/fuchsia, utilisé pour liens, CTA, sélection), accent secondaire `#1192DE` (bleu piscine, pour les survols et icônes nav). Typographie corps en gris `#555` sur fond blanc, et police décorative Satisfy (script) pour les éléments anniversaire.
- **Logo** : monogramme rectangulaire stylisé inscrit dans un cadre arrondi, lettres "PISCINELLE" composées de glyphes hauts et fins évoquant un graphisme architectural / brutaliste. Monochrome (noir sur header blanc, blanc en survol sur header coloré). Forme verticale, presque tampon, sobre et identifiable.
- **Univers général** : très photographique, plein écran, dominé par des images haute définition de piscines en bois exotique (ipé, cumaru) au bord de maisons contemporaines. Tonalité éditoriale, vocabulaire émotionnel ("émotion esthétique", "proportions divines"), peu de bruit visuel, beaucoup d'espace blanc, header transparent qui se colore au scroll. L'ensemble vise un public CSP+ en recherche d'objet d'architecture autant que de loisir.

## Formulaire (résumé)

Le configurateur enchaîne 3 étapes produit puis un formulaire contact :

1. **Forme** : modèle parmi Cr / Bo / Cn / Ds / Iki / Or (`config[modele]`)
2. **Dimensions** : longueur × largeur × hauteur (`config[dim]`, `config[superficie]`)
3. **Options** (toutes optionnelles, fortement combinatoires) :
   - Couleur de l'eau / liner (`couleur_eau`) — 9 teintes (bleu clair, adriatique, vert argile, sable, blanc, gris clair, ardoise, noir, bleu marbré)
   - Accès : Escabanc / échelle inox (`escalier`)
   - Margelles : ipé premium, Design+, classiques, sans (`margelles`)
   - Chauffage : pompe à chaleur, réchauffeur (`chauffage`)
   - Couvertures : bâche solaire, hivernage, à barres, Rolling-Deck, volet immergé / hors-sol, Aqualarm V2 (`couvertures`)
   - Projecteurs LED blanc / couleur, lame d'eau (`projecteurs`)
   - Traitement de l'eau : régul pH auto, brome auto, électrolyseur, robot Dolphin S200 (`traitement_eau`)
   - Fitness : nage à contre-courant, Aquabike (`fitness`)
   - Terrasse : ipé / cumaru / sapin + superficie m² (`terrasse`, `terrasse_superficie`)
   - Local technique : Hozon, LT2, kit hors-sol (`lt`)

Puis qualification projet et contact : nom, prénom, email, téléphone, pays (liste complète), code postal, ville, adresse, type de résidence (principale / secondaire), budget, mode d'installation, date de projet, description libre, source ("connu"), niveau de définition du projet, choix de mode de contact. Calcul de prix immédiat avec mensualité affichée.

## Pertinence pour notre projet

Cas d'école très intéressant pour Aithos : produit physique complexe à très forte combinatoire (6 modèles × dimensions continues × ~30 options groupées en 10 familles), où chaque choix a une implication esthétique, technique et budgétaire. Le client final n'est pas équipé pour arbitrer seul — Piscinelle s'appuie donc sur un réseau de conseillers humains que le formulaire qualifie en amont (budget, résidence, horizon de projet, niveau de définition). C'est exactement la zone où un agent IA peut apporter de la valeur : pré-qualifier le projet, mémoriser les préférences, expliquer les arbitrages liner/margelles/couverture, simuler des scénarios, et préparer un dossier propre pour le conseiller. La présence d'un configurateur public et tarifé indique aussi une culture de transparence côté marque — terrain favorable à un outil IA orienté décision.
