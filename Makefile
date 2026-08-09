all:
	rm -f us.johnholbrook.pihole.streamDeckPlugin
	# Use Elgato's CLI packager. The .sdPlugin folder MUST appear at the zip
	# root (us.johnholbrook.pihole.sdPlugin/manifest.json); a zip with
	# manifest.json at the root is rejected by the Stream Deck app.
	npm run build
	streamdeck bundle us.johnholbrook.pihole.sdPlugin --output .
