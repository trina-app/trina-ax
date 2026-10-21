// The product's names for shell scripts and other non-TypeScript builds (shared/src/product.ts is the one place they
// are written): `bun scripts/product-env.ts` prints product.env (PRODUCT_NAME=..., one per line; read it with sed,
// never `source`). menubar/build.sh uses it; build-office.ts and build-bundle.ts write the same lines into their
// bundles (app/product.env, product.env) for office-install.sh, office-uninstall.sh and install-macos.sh.
import { productEnv } from '../shared/src/product'

if (import.meta.main) process.stdout.write(productEnv())
