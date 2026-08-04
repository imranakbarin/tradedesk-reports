# Car ID

Upload a photo of a car, get back its brand, model, year range, and features — plus the
visual cues behind the identification.

Runs locally. Your Anthropic API key stays on the server in `.env` and is never sent to the
browser.

## Setup

```bash
cd car-id
npm install
cp .env.example .env      # then paste your key from console.anthropic.com
npm start
```

Open http://localhost:3000 and drop in a photo (or paste one from the clipboard).

## How it works

The browser downscales the image to 2576px on the long edge — Claude Opus 5's
high-resolution vision limit — then posts it to `POST /api/identify`. The server calls the
Messages API with a JSON schema, so the response comes back as structured fields rather than
prose, and the UI renders them directly.

The result separates observation from inference: body shape, badges, lights, and wheels are
read from the photo, while engine options and drivetrain are inferred from the identified
model and labelled as such. When the photo is partial, dark, or badge-free, the model lowers
its confidence and lists alternatives instead of guessing.

## Checks

```bash
npm start          # in one terminal
npm run smoke      # in another — validation, error mapping, and the identify path
```
