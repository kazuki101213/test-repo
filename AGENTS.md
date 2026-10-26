# UI typography

Admin and delivery apps use the font family in packages/shared/src/typography.css, matching the delivery app's staff selector. All text, including headings, SKU values, form controls, and invoices, must use this shared font family. New UI must inherit it; do not introduce serif or monospace font overrides. Text sizes may vary according to the UI, except the delivery task section heading must match the 15px staff selector.

# Deployment reliability

Before any release or statement that this app cannot be published, read `docs/deployment-runbook.md`. A failed Git deployment alone is not a complete diagnosis: inspect matching READY builds, consider the documented same-project alias switch, and use the existing authenticated API to publish the verified main commit when appropriate. Never substitute an older or partial build and call it current.

Automatic Git deployments are intentionally limited to `main` in both app configurations to conserve the shared Vercel deployment allowance. Keep PR CI checks; do not restore automatic branch previews without a new user request. Verify each intended public domain's commit, READY state and delivered assets before reporting publication complete.
