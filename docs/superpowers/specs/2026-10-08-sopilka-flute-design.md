# Sopilka and flute — design

Two new instruments next to the guitar … handpan: the Ukrainian sopilka and the concert flute. Both play
one note at a time, so a chord is shown and played the way a melody player outlines it: its arpeggio,
with the fingering of every note.

## What the user gets

- «Сопілка» and «Флейта» in the instrument picker (wide: segmented buttons; phones: the menu, with an
  icon each), in the I-key cycle after the handpan, synced with the account like the other instruments
  (the Firestore rules allow both values; deployed before the client).
- **Diagram**: one fingering column per arpeggio note (3–4): the body from the mouthpiece down, covered
  holes / pressed keys in the chord colour, open ones outlined, half-covered (not needed by either chart,
  supported) as a half-filled hole, thumb holes on the back dashed at the side, a dashed line between the
  hands, a chevron over an overblown note, the note name underneath. A click on a column plays that note,
  elsewhere the arpeggio; sounding columns get a fading ring like the other diagrams.
- **Sound**: the arpeggio, note after note, tongued; the play-along plays it a note per beat.

## Arpeggio rules (`src/lib/wind/arpeggio.ts`)

Root, third / sus note, fifth, then 7th / 6th / 9th; a triad closes on the octave (1-3-5-8); five-note
chords drop the fifth; a slash bass starts the line (inversion, or the bass under the root). First note at
or above the instrument's `startLow`, each next one the nearest above; past the top → down an octave, or
drop what is still out of reach. Spelled by chord degree.

## Research (subagents, 2026-10-08)

**Sopilka.** The standard taught today is the chromatic soprano «прима» in C, Dmytro Demenchuk's ten-hole
system (not Skliar's earlier concert sopilka); sounding C5–G7, written an octave lower; schools use the
Melnytsia-Podilska model (32 cm). Holes: left thumb (back), L1–L4, right thumb (back), R1–R4, the little
fingers' set off; every chromatic note a fork fingering; the second octave reuses the first octave's
fingerings blown harder, except G♯6. Chart: M. Kulbovskyy, «Голосом сопілки», p. 15, identical to the
Kyiv chart «Аплікатура сопілки прима» (recorderhomepage.net/sopilka). The third octave is only in the
low-resolution Kyiv chart → the app stops at B6. Folk ensembles give the sopilka the melody; a light
vibrato only on long notes, ornaments instead.

**Flute.** C4–C7 (B foot B3), registers low C4–C♯5, middle D5–C♯6, high D6 up; beginners E4–G5,
intermediate D4–D6, A6 up shrill. Standard first fingerings verified in two charts (Woodwind Fingering
Guide, flutetunes.com); B♭6 and B6 need the trill keys → the chart stops at A6 (the arpeggios never go
above D♯6).

**Timbre.**
- Flute: harmonic levels read off the UNSW measured spectra (C4 loud, A4, C5, G5, C6, G6); Fletcher 1975:
  low register h2 / h3 ≥ h1, middle led by h1, high > 10 dB down; attack a near-constant number of periods
  (Grobben 1967: ~20–26 staccato, ~50–60 detached); breath noise ~35–45 dB under the tone, pulsing with the
  period (Nishimura 2001, Chafe 1993); vibrato ~5 Hz, ±10 cents, mostly level and brightness (h1 ±15 %, h4
  ±70 %), delayed ~200 ms.
- Sopilka: no published measurement; recorder (Ando & Shima 1978: ~4 dB per harmonic, even ones ~10 dB
  lower) blended with the tin whistle (Timoney et al., DAFx-04); overblown notes ~6 dB poorer; flue-pipe
  attack 10–30 ms with a chiff (Ernoult & Fabre 2017, Castellengo 1999); release 40–80 ms (estimate).

## Voice (`src/lib/sound/wind.ts`)

Additive resynthesis rendered offline once per (instrument, key, sample rate): the attack, then exactly
one steady loop (~1.6 s of whole periods, whole vibrato cycles, a periodic wander and a seamless periodic
breath noise), so the engine loops it for any hold and fades it out over 60 ms when the breath stops
(`startWindNote`). The loop's pitch is exact to a few hundredths of a cent.

## Out of scope

Grace notes / trills, other sopilka sizes (alto, tenor), the 6-hole diatonic sopilka, the flute's third
octave above A6, choosing the nearest chord tone (voice leading) instead of the arpeggio.
