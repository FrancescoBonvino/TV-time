# TV Time 2.0

App web mobile-first (PWA) per segnare serie TV, anime e film: episodi visti, "continua a guardare",
calendario delle uscite, libreria, reazioni, voti e statistiche (tempo passato a guardare).

## Come metterla sul telefono (gratis, 3 minuti)
1. Carica questa cartella su un hosting statico con HTTPS: GitHub Pages, Netlify Drop (netlify.com/drop) o Cloudflare Pages.
2. Apri l'indirizzo dal telefono. Su iPhone: Condividi > Aggiungi a Home. Su Android: menu > Installa app.

## API gratuite usate (nessuna chiave)
- TVmaze: serie TV, episodi, date di uscita
- AniList (GraphQL): anime, numero episodi, prossima puntata
- Cinemeta (catalogo IMDb): film, locandine, trama
- GitHub Gist: sincronizzazione dell'account tra dispositivi (facoltativa)

## Account e sincronizzazione
Profilo > Account: incolla un token GitHub con il solo permesso "gist". I dati vanno in un Gist privato
e si uniscono tra i dispositivi (vince l'ultima modifica, episodio per episodio).
Senza account i dati restano sul dispositivo; Profilo > Esporta crea una copia di sicurezza.

## File
index.html, style.css, core.js (logica), app.js (schermate e API), sw.js (offline), manifest.webmanifest, icone.
