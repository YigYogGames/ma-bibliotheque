# 📚 Ma Bibliothèque

Application de bibliothèque virtuelle pour Android (et bientôt iPhone).

- **Scanner** le code-barres d'un livre pour l'ajouter (infos et couverture trouvées automatiquement)
- **Séries** : tomes possédés, tomes manquants
- **Sorties prévues** : les prochains tomes de tes séries, par date de sortie
- **Décors** : Bois, Nuit, Papier, Pastel, Manga
- Tri, recherche, modification, sauvegarde / restauration

## Installer sur Android

1. Va dans **Releases** (à droite sur la page du dépôt) et ouvre la plus récente.
2. Télécharge **MaBibliotheque.apk** depuis ton téléphone et ouvre-le.
3. Autorise l'installation depuis cette source si le téléphone le demande.

Chaque modification du code fabrique automatiquement un nouvel APK (onglet **Actions**).

## Organisation du code

- `www/` : l'application (HTML, CSS, JavaScript)
- `capacitor.config.json` : configuration (Capacitor transforme l'app web en app Android / iOS)
- `.github/workflows/build-apk.yml` : compilation automatique de l'APK
- `scripts/patch-android.js` : icône, numéro de version
- `signing/debug.keystore` : clé de signature de test (permet d'installer les mises à jour par-dessus)

Infos des livres : Google Books, catalogue de la BnF et Open Library.
