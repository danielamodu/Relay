<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->
---
name: Relay Agent Dashboard
description: High-contrast, premium editorial dashboard for autonomous schema translation monitoring
colors:
  neutral-bg: "#ffffff"
  neutral-text: "#000000"
  neutral-border: "#e5e5e5"
  neutral-muted: "#737373"
  neutral-card: "#fafafa"
typography:
  display:
    fontFamily: "Geist, Inter, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Geist, Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Mono, JetBrains Mono, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  none: "0px"
  sm: "2px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
---

# Design System: Relay Agent Dashboard

## 1. Overview

**Creative North Star: "Stark Verification"**

A high-contrast, premium, editorial-grade dashboard built strictly in black and white to match the geometric brand logo. It rejects SaaS clichés (like gradient buttons, glowing cards, and rounded pill badges) in favor of crisp typography, structural borders, and structured spacing.

**Key Characteristics:**
* Pure black and white contrast.
* Monospaced alignment for data flows and cryptographic receipts.
* Sharp, zero-radius borders matching the square brand asset.

## 2. Colors

A strictly monochromatic color strategy with zero decorative hues. Color is used only as tinted neutrals to support hierarchy.

### Neutral
- **Pure White** (#ffffff): Main dashboard canvas background.
- **Stark Black** (#000000): Primary text, headings, and signature buttons.
- **Bone White** (#fafafa): Section card fills.
- **Clean Gray** (#e5e5e5): Divider lines and boundaries.
- **Muted Charcoal** (#737373): Low-priority metadata and timestamps.

**The Absolute Monochromatic Rule.** Color is completely forbidden. No green for active status, no red for errors. Use clean typographic labels (e.g. `[ONLINE]`, `[ERROR]`, `[IDLE]`) and weight changes instead of color signals.

## 3. Typography

**Display Font:** Geist or Inter
**Body Font:** Geist or Inter
**Label/Mono Font:** Geist Mono or JetBrains Mono

**Character:** Crisp, technical, and highly structured layout spacing. Displays a high-end publication feel.

### Hierarchy
- **Display** (600, 32px, 1.2): Section titles and main headers.
- **Body** (400, 14px, 1.5): Standard lists, properties, and details.
- **Label** (400, 13px, 1.6): Raw JSON/XML payloads, hash signatures, and terminal log files.

## 4. Elevation

The system is entirely flat. Shadows are prohibited. Depth is indicated exclusively by clean gray dividers and container backgrounds.

**The Flat Surface Rule.** Depth is structural, not physical. Never use box-shadows or bluts to represent layer changes.

## 5. Components

No components are built yet.

## 6. Do's and Don'ts

### Do:
- **Do** rely on monospaced font families for code blocks, hash values, and state labels.
- **Do** use strict sharp corners (0px border-radius) for all buttons and boxes.
- **Do** express states using text updates (e.g. `[ONLINE]`) and layout positioning.

### Don't:
- **Don't** use any accent colors (such as neon green, blue, or purple gradients).
- **Don't** use card shadows, drop-shadows, or glassmorphic blur effects.
- **Don't** use rounded badge elements or side-stripe border accents.
