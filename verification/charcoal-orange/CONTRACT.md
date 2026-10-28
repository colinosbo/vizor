# Charcoal and orange visual direction

Requested October 28, 2026: dark grey surfaces with bright orange accents, followed by needed polish and verification of the existing local workspace. Autopilot stays off; no new autonomous behavior or hosted deployment is part of this visual update.

Primary job: connect providers, read and steer conversations, review proposed actions and control spending. Keep existing navigation, panel layouts, approval boundaries and account behavior. Apply the palette throughout the actual app, not just the landing screen.

- Canvas: charcoal grey. Cards, dialogs, panel headers and inputs use neutral grey layers without green casts.
- Primary actions, selected navigation, focus rings and key highlights: bright orange with dark text on filled buttons. Keep orange concentrated on actions and orientation so conversations remain easy to read.
- Body and secondary copy: neutral white/grey with sufficient contrast. Preserve distinctive agent colour choices and clear warning/error semantics.
- Desktop target: 1440 × 900. Mobile target: 390 × 844. No horizontal overflow, reachable composers, scrolling panels and keyboard-visible focus. Respect reduced motion.
- Exercise loading, empty, error, partial, success and approval states using isolated provider mocks. Retain screenshots and run existing browser accessibility checks. Real provider inference needs a key supplied through the app and remains outside mocked verification.

Local references: the existing Vizor workflow and verified orchestration screens. No external design service, remote assets or additional dependencies are needed.
