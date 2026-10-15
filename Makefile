UUID = knobflow@felipe.local
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all compile-schemas compile-locales install uninstall link enable disable prefs pack clean

all: compile-schemas compile-locales

compile-schemas:
	glib-compile-schemas schemas/

compile-locales:
	python3 scripts/compile_po.py po/es.po locale/es/LC_MESSAGES/knobflow.mo

install: compile-schemas compile-locales
	mkdir -p "$(EXT_DIR)"
	cp -r metadata.json extension.js audioManager.js keyManager.js osdManager.js prefs.js stylesheet.css schemas locale "$(EXT_DIR)/"
	@echo "Instalación completada en $(EXT_DIR)"

link: compile-schemas compile-locales
	mkdir -p "$(HOME)/.local/share/gnome-shell/extensions"
	rm -rf "$(EXT_DIR)"
	ln -sfn "$(CURDIR)" "$(EXT_DIR)"
	@echo "Enlace simbólico creado hacia $(EXT_DIR)"

uninstall:
	rm -rf "$(EXT_DIR)"
	@echo "Extensión desinstalada."

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

pack: compile-schemas compile-locales
	gnome-extensions pack --force --podir="" \
		--extra-source=audioManager.js \
		--extra-source=keyManager.js \
		--extra-source=osdManager.js \
		--extra-source=stylesheet.css \
		.
	zip -u $(UUID).shell-extension.zip locale/es/LC_MESSAGES/knobflow.mo
	@echo "Paquete generado: $(UUID).shell-extension.zip"

clean:
	rm -f schemas/gschemas.compiled *.zip locale/es/LC_MESSAGES/knobflow.mo
