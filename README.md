# HomeBuild AI

AI-powered material takeoff platform for custom home builders.

Upload a floor plan PDF or image → get an accurate framing, roof, envelope, and foundation material list in minutes.

## Setup

### 1. Get your Anthropic API key
- Go to console.anthropic.com
- Click API Keys → Create Key
- Name it "HomeBuild AI" and copy the key

### 2. Deploy to Render (no terminal needed)
1. Push this folder to a GitHub repository
2. Go to render.com → New → Web Service
3. Connect your GitHub repository
4. Set these settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add environment variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your API key from step 1
6. Click Deploy

Your app will be live at `your-app-name.onrender.com`

## What it does
- Upload PDF, PNG, or JPG floor plans
- AI extracts: dimensions, door/window schedules, roof data, framing specs
- Rules engine calculates: studs, plates, headers, trusses, sheathing, insulation, concrete
- Exports: CSV material list, printable report
- 3D model viewer built from extracted dimensions

## Assembly Rules
All material calculation logic is documented in `HomeBuild_AI_Spec.docx`.
Rules cover: exterior walls (2x6), interior walls (2x4/2x6 plumbing), roof framing, metal panel siding/roofing, open-cell spray foam insulation, monolithic slab foundation.
