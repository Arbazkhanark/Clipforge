# Setup
Requires Node >= 22.18 (runs TypeScript natively; no install needed for current tests).

    npm test            # runs the Phase 0 billing tests
    npm run typecheck   # needs `npm install` first (@types/node, typescript)

Copy `.env.example` to `.env` and fill in real values later. Never commit `.env`.
Web app, database and S3 setup will be added when those phases are built.
