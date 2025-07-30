# singaseongj.github.io

This repository contains files used for the Singaseong website.

## Running tests

The repository includes a simple Node.js script that verifies the `apple-app-site-association` file. Make sure Node.js is installed and run:

```bash
node tests/apple_association.test.js
```

If the file is valid you will see `All tests passed`.

To refresh daily stock recommendations and rebuild the site:

```bash
npm run build
```

The build script fetches trending stocks from Yahoo Finance (if network access is available) and writes them to `recommendations.json` before generating `stocks.html`.
