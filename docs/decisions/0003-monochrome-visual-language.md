# ADR 0003 — Monochrome visual language

## Status

Accepted.

## Decision

Bubble uses a restrained, Apple-like dark visual system:

- true black is the primary canvas;
- interface chrome is white and neutral gray only;
- hierarchy comes from type, spacing, opacity, and thin separators;
- panels are reserved for controls that need explicit grouping;
- photos provide the color in the product;
- decorative gradients are prohibited outside the subtle spherical
  light-and-shadow treatment inside Memories bubbles.

Status, error, focus, and selection states must remain accessible through
contrast, labels, weight, borders, and shape rather than decorative color.

## Consequence

New feature work should reuse the existing monochrome controls and flattened
section patterns. A new colored accent, decorative glass panel, glow, or
gradient requires an explicit design review.
