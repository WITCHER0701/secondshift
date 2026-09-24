# 🎬 AD-VIDEO-KIT.md — the SecondShift ad, $0, ready to paste today

## 0 · The honest tool verdict (verified Sep 2026, live search)

**No AI video generator on Earth gives you one free 20s+ clip.** Every free tier caps single clips at 5–10s. That's fine — ads are *cut*, not *poured*. You generate 4 short clips and assemble them in a free editor. Here is the verified table:

| Tool | Free tier (verified) | Clip length | Watermark | Card needed |
|---|---|---|---|---|
| **Google Veo 3.1** — gemini.google.com or aistudio.google.com | ~3–5 generations **per day** (refreshes daily) | **8s** | small "Veo"/Gemini watermark on free | No (Google account) |
| **Kling AI** — app.klingai.com | **66 credits/day** ≈ 3–6 clips daily | 5s std (5–10s modes) | yes, bottom corner | No |
| **Bing Video Creator** (Sora, inside the Bing **phone app**) | free daily generations | 5s | small watermark | No (Microsoft account) |
| **Luma Dream Machine** | 30/month, 720p | 5s | permanent + personal-use only | No |
| CapCut Desktop / Clipchamp (assembly) | free | unlimited timeline | none on manual export | No |

**Recommended stack:** 4× Veo 3.1 clips (8s each = 32s raw, cut to 30s) — Veo free tier is the best quality-per-dollar($0) and its clips ship **with native audio** (room tone, phone buzz). Top up missing shots with Kling's daily 66 credits. Assemble in **CapCut Desktop**.

**Golden rule for every prompt below:** AI mangles on-screen text. We add ALL text (clock, captions, CTA) in the editor, never in the prompt. Prompts say "no text, no logos" where needed.

---

## 1 · The concept — "The 9:07 PM Missed Call" (30s)

A one-person salon closes at 9. At 9:07 a customer calls. Nobody answers — except her second shift. One night, four lost customers become four booked appointments, and the owner wakes up to a business that worked while she slept.

**Emotional arc:** loss (9:07 missed call) → rescue (The Voice answers) → compounding (reviews + content + leads) → payoff (morning: booked, protected, scheduled).

**Tone:** premium, calm, cinematic. Not techy-blue-startup. Warm tungsten night interiors, one crisp morning. 24fps filmic, shallow depth of field.

---

## 2 · Shot-by-shot (fill 30s exactly)

| # | Time | Shot | On-screen text (added in CapCut) | VO (see §4) |
|---|---|---|---|---|
| 1 | 0:00–0:07 | 9:07 PM. A phone face-down on a nightstand lights up, buzzing. "SALON OPEN 9–9" sign in the dark window behind. | `9:07 PM` → `missed call #3 this week` | "At 9:07 PM, her business called. She was asleep." |
| 2 | 0:07–0:15 | The same call answered on a laptop screen: a calm voice waveform UI, then an appointment confirmation slides in. | `The Voice — your second shift` | "Her AI receptionist answered. Booked the appointment. Took the name, the number, the time." |
| 3 | 0:15–0:22 | Rapid montage: a 5★ review lands on a Google-style card; a week of social posts auto-arranges on a calendar; a new lead gets a reply. | `reviews protected` · `content scheduled` · `leads qualified` | "Reviews stay five-star. A week of content, scheduled. Every lead, answered." |
| 4 | 0:22–0:30 | Morning. She picks up the phone: "Appointment booked — 9:14 PM". Small smile. Cut to black card. | `SecondShift` → `secondshift.space` → `Your second shift starts tonight.` | "While she slept, SecondShift worked. SecondShift — your second shift starts tonight." |

---

## 3 · Paste-ready prompts (matched to each tool)

### Clip 1 — Veo 3.1 (8s)
```
Cinematic night interior, a small hair salon after closing. A smartphone face-down on a wooden nightstand suddenly lights up and buzzes with an incoming call, screen glow spilling across the sheets. In the background, a dark shop window with a neon "OPEN 9–9" sign turned off. Slow push-in on the buzzing phone, shallow depth of field, warm tungsten tones against cool blue moonlight, 35mm film look, photorealistic, no people, no readable text, ambient room tone and a soft phone vibration buzz.
```
*(Bing/Sora 5s version: same, delete "slow push-in". Kling 5s version: same + "static camera".)*

### Clip 2 — Veo 3.1 (8s)
```
Over-the-shoulder cinematic shot, a modern laptop in a dark living room, screen glow the only light. On screen: a minimalist AI voice-call interface with an elegant animated waveform pulsing as a woman's calm voice speaks, then a clean appointment confirmation card slides up. Camera drifts slowly right, shallow depth of field, warm and premium color grade, photorealistic UI glow, no readable text on screen, soft electronic ambience.
```

### Clip 3 — Veo 3.1 (8s)
```
Cinematic macro montage sequence, premium tech-commercial style: a five-star rating animation materializing on a smartphone, a weekly content calendar filling itself with neat post cards one by one, a chat bubble replying instantly to an incoming business lead. Consistent dark elegant background with soft rim light, quick but smooth transitions, shallow focus, photorealistic, high-end advertising look, no readable text, subtle uplifting synth swell.
```

### Clip 4 — Veo 3.1 (8s)
```
Golden morning light through half-open blinds, a woman in her thirties wakes up and picks up the phone from the nightstand. Her face softens into a quiet, satisfied smile as she reads something on the screen. Close-up on her relaxed expression, warm honey tones, 35mm film grain, slow gentle zoom, photorealistic, no readable text on the phone, soft hopeful ambient tone.
```

### If Veo is out of daily credits → Kling equivalents
Same prompts, append Kling style suffix: `--ar 16:9, cinematic, photorealistic, high detail`. (If using the phone-app 9:16 variant for Reels/Shorts, append `--ar 9:16`.)

### Screen-recording shots (stronger than AI for the UI moments)
Record the real product at localhost:4000 — authentic beats generated:
- `test-drive.html` → The Voice → book "haircut tomorrow 2pm" (this becomes Clip 2's second half)
- `admin.html` → Voice Ops + appointments table
CapCut: screen recording inside the laptop screen of Clip 2 with a subtle screen-glow effect.

---

## 4 · Voiceover — free with your own stack

You already ship **Kokoro TTS** in `voice.html` (the neural voice of The Voice). Generate the VO free with the same stack:

1. `npm i kokoro-js` (or reuse the voice page's pipeline), then synthesize these 4 lines, voice `af_heart`/`am_michael`, speed 1.0:
   - L1: "At nine-oh-seven PM, her business called. She was asleep."
   - L2: "Her AI receptionist answered. Booked the appointment. Took the name, the number, the time."
   - L3: "Reviews stay five-star. A week of content, scheduled. Every lead, answered."
   - L4: "While she slept, SecondShift worked. SecondShift — your second shift starts tonight."
2. 70 words ≈ 27–28s at a calm ad pace — fits 30s with 1s of air before the CTA card.
3. CapCut: duck the music −6dB under VO (auto-ducking is built in).

**Music:** CapCut free library → search "minimal piano pulse" or "inspiring tech calm" (or Clipchamp "corporate uplifting minimal"). Cut to hit the montage at 0:15 and the logo at 0:22.

---

## 5 · Assembly (CapCut Desktop, 20 min)

1. New project → 1920×1080 (make a second 1080×1920 pass for Reels later).
2. Import 4 clips in order; trim each to the times in §2.
3. Add on-screen text (§2 column) — font: a clean sans (Inter/Poppins), white, small, bottom-third or center; fade each in 200ms.
4. VO on track 2; music on track 3 ducked.
5. End card: black, 2.5s, `SecondShift` wordmark + `secondshift.space` (your real logo.png works).
6. Export 1080p — free exports have no watermark.

## 6 · Where to post it

Pinned on secondshift.space hero (drop file into `public/`, reference in index.html), LinkedIn + Instagram Reels + YouTube Shorts (9:16 pass), and attach to every cold email/proposal. One 30s asset, four placements, $0 spent.
