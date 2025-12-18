# streamdeck-pihole
[Stream Deck](https://www.elgato.com/en/stream-deck) plugin for monitoring & controlling [Pi-hole](https://pi-hole.net).

Available on the Stream Deck App Store: https://apps.elgato.com/plugins/us.johnholbrook.pihole.

The .streamDeckPlugin file can also be downloaded from this repository's "releases" page, but installation from the store is preferred for automatic updates.

## Developing

### Install from Source

1. If you have the plugin installed from the Stream Deck store, uninstall it.
2. Install Node.js and the Stream Deck CLI as described on [this page](https://docs.elgato.com/streamdeck/cli/intro).
3. Clone this repository, then navigate to it in a terminal.
4. Run `npm install` to install development dependencies.
5. Run `streamdeck link us.johnholbrook.pihole.sdPlugin`.

You have now linked (installed) the local version of the plugin for development. At this point, you can make changes to the plugin.

### Build and Test

The plugin code is in the folder `us.johnholbrook.pihole.sdPlugin`. Most of the functionality of the plugin is in `src/plugin.js` (up one level), while the "property inspector" (configuration UI in the Stream Deck software) is in the `pi` subdirectory.

To test changes to the code:
1. (optional) Enable debug logging by changing the log level at top of `src/plugin.js` from INFO to DEBUG. Logs will be located in `logs/us.johnholbrook.pihole0.log` inside the plugin folder.
2. If you have edited `src/plugin.js`, run `npm run build` to generate `bin/plugin.js` with dependencies bundled. You can also run `npm run watch` to automatically rebuild when you save changes.
3. Run `streamdeck restart us.johnholbrook.pihole` to relaunch the Stream Deck app with your latest changes.

**Tip:** For more info see the [Stream Deck SDK docs](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started).
