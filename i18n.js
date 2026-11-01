// The complete v1 string table (SPEC.md §9.2). Keys are grouped by prefix; a page
// must not use a key that is not listed in the spec. Spanish = neutral LATAM.
// Tone rules (§9.3): terse, sentence case, no exclamation marks, no emoji.
export const LANGS = ["en", "es"];
export const DEFAULT_LANG = "en";

export const STRINGS = {
  "app.title": { en: "Hacklab inventory", es: "Inventario del hacklab" },
  "app.subtitle": {
    en: "Track the things on the shelves of the space.",
    es: "Registro de las cosas que están en los estantes del espacio.",
  },

  "nav.home": { en: "Items", es: "Cosas" },
  // Page title of the inventory list, so the tab does not read "Items — Hacklab inventory".
  "list.title": { en: "Inventory", es: "Inventario" },
  "nav.print": { en: "Print stickers", es: "Imprimir etiquetas" },
  "nav.login": { en: "Log in", es: "Entrar" },
  "nav.logout": { en: "Log out", es: "Salir" },
  "role.admin": { en: "admin", es: "admin" },
  "role.member": { en: "reader", es: "lectura" },
  "nav.ui_lang": { en: "Language", es: "Idioma" },
  "nav.export": { en: "Export CSV", es: "Exportar CSV" },

  "auth.login_cta": {
    en: "Continue with Kanidm",
    es: "Continuar con Kanidm",
  },
  "auth.must_login": { en: "Log in to continue", es: "Inicia sesión para continuar" },
  "auth.must_login_detail": {
    en: "This sticker is not registered yet. Log in to register the item.",
    es: "Esta etiqueta todavía no está registrada. Inicia sesión para registrar la cosa.",
  },
  "auth.denied": {
    en: "You did not finish logging in. Try again.",
    es: "No terminaste de iniciar sesión. Inténtalo de nuevo.",
  },
  "auth.callback_error": {
    en: "The login could not be completed. Start again.",
    es: "No se pudo completar el inicio de sesión. Empieza de nuevo.",
  },

  "scan.public_title": { en: "Item", es: "Cosa" },
  "scan.not_found": { en: "Unknown sticker", es: "Etiqueta desconocida" },
  "scan.not_found_detail": {
    en: "This code is not a valid sticker of this inventory. Check the code and try again.",
    es: "Este código no es una etiqueta válida de este inventario. Revisa el código e inténtalo de nuevo.",
  },
  "scan.revoked": { en: "Sticker revoked", es: "Etiqueta revocada" },
  "scan.deleted": { en: "Item deleted", es: "Cosa eliminada" },
  "scan.reused": {
    en: "This sticker was printed before and registered again: it now belongs to this item. Print a fresh sticker if it is still on something else.",
    es: "Esta etiqueta ya se había impreso y se registró otra vez: ahora pertenece a esta cosa. Imprime una etiqueta nueva si todavía está en otra.",
  },
  "scan.unclaimed_prompt": {
    en: "New sticker: register the item it is on.",
    es: "Etiqueta nueva: registra la cosa que tiene pegada.",
  },
  "scan.claim_cta": { en: "Register item", es: "Registrar la cosa" },

  // §8.9: add by phone (scan a printed sticker, then fill the form)
  "nav.add": { en: "Add", es: "Agregar" },
  "add.title": { en: "Add an item", es: "Agregar una cosa" },
  "add.subtitle": {
    en: "Scan the sticker on the thing, then write down what it is.",
    es: "Escanea la etiqueta de la cosa y luego anota qué es.",
  },
  "add.camera_hint": { en: "The camera opens here.", es: "La cámara se abre aquí." },
  "add.camera_start": { en: "Start camera", es: "Encender la cámara" },
  "add.camera_stop": { en: "Stop camera", es: "Apagar la cámara" },
  "add.camera_denied": {
    en: "No camera access. Allow it in the browser, or type the code.",
    es: "Sin acceso a la cámara. Permítelo en el navegador o escribe el código.",
  },
  "add.unsupported": {
    en: "This browser cannot read QR codes here. Type the sticker code instead.",
    es: "Este navegador no puede leer códigos QR aquí. Escribe el código de la etiqueta.",
  },
  "add.manual": { en: "Or type the sticker code", es: "O escribe el código de la etiqueta" },
  "add.scanning": { en: "Looking for a sticker…", es: "Buscando una etiqueta…" },
  "add.not_ours": {
    en: "That QR code is not one of our stickers.",
    es: "Ese código QR no es una de nuestras etiquetas.",
  },
  "add.continue": { en: "Continue", es: "Continuar" },
  "add.https_hint": {
    en: "The camera and the install option need https (or localhost on a computer).",
    es: "La cámara y la opción de instalar necesitan https (o localhost en una computadora).",
  },

  "item.photo": { en: "Photo", es: "Foto" },
  "photo.none": { en: "No photo yet.", es: "Todavía no hay foto." },
  "photo.add_more": { en: "Add another photo", es: "Agregar otra foto" },
  "photo.delete": { en: "Delete photo", es: "Borrar foto" },
  "photo.add": { en: "Take or choose a photo", es: "Tomar o elegir una foto" },
  "photo.upload": { en: "Upload", es: "Subir" },
  "crop.rotate": { en: "Rotate", es: "Girar" },
  "crop.whole": { en: "Use whole photo", es: "Usar foto completa" },
  "crop.apply": { en: "Crop", es: "Recortar" },
  "crop.cancel": { en: "Cancel", es: "Cancelar" },
  "photo.hint": {
    en: "Up to 8 photos. JPEG, PNG or WebP, 8 MB each; a phone sends a smaller copy.",
    es: "Hasta 8 fotos. JPEG, PNG o WebP, 8 MB cada una; un teléfono envía una copia más chica.",
  },

  "item.name": { en: "Name", es: "Nombre" },
  "item.category": { en: "Category", es: "Categoría" },
  "item.model": { en: "Model", es: "Modelo" },
  "item.serial": { en: "Serial", es: "Número de serie" },
  "item.location": { en: "Location", es: "Ubicación" },
  "item.status": { en: "Status", es: "Estado" },
  "item.held_by": { en: "Held by", es: "En manos de" },
  "item.qty": { en: "Quantity", es: "Cantidad" },
  "item.notes": { en: "Notes", es: "Notas" },
  "item.created": { en: "Created", es: "Creada" },
  "item.updated": { en: "Updated", es: "Actualizada" },

  "item.status.available": { en: "available", es: "disponible" },
  "item.status.in_use": { en: "in use", es: "en uso" },
  "item.status.broken": { en: "broken", es: "rota" },
  "item.status.missing": { en: "missing", es: "perdida" },

  "form.field_required": { en: "Required", es: "Obligatorio" },
  "form.register": { en: "Register", es: "Registrar" },
  "form.save": { en: "Save item", es: "Guardar" },
  "form.cancel": { en: "Cancel", es: "Cancelar" },
  "form.notes_placeholder": {
    en: "What you would want to know in a year",
    es: "Lo que querrías saber dentro de un año",
  },
  "form.qty_mode": { en: "Quantity mode", es: "Modo de cantidad" },
  "form.qty_mode.count": { en: "One serialized thing", es: "Una sola cosa con serie" },
  "form.qty_mode.bin": { en: "A bin of identical parts", es: "Una caja de partes iguales" },
  "form.name_placeholder": { en: "Monitor LG 24", es: "Monitor LG 24" },
  "form.model_placeholder": { en: "24MP59G", es: "24MP59G" },
  "form.serial_placeholder": { en: "as printed on the label", es: "tal como está en la etiqueta" },
  "form.held_by_placeholder": { en: "Name or nickname", es: "Nombre o apodo" },
  "form.location_placeholder": { en: "Shelf 3", es: "Estante 3" },
  "form.category_placeholder": { en: "monitor", es: "monitor" },

  "action.edit": { en: "Edit fields", es: "Editar los datos" },
  "action.set_status": { en: "Set status", es: "Cambiar el estado" },
  "action.qty_plus": { en: "Add one", es: "Sumar uno" },
  "action.qty_minus": { en: "Remove one", es: "Restar uno" },
  "action.qty_set": { en: "Set…", es: "Fijar…" },
  "action.rebind": { en: "Print new sticker", es: "Imprimir etiqueta nueva" },
  "action.rebind_confirm": {
    en: "The current sticker stops working. Continue?",
    es: "La etiqueta actual deja de funcionar. ¿Continuar?",
  },
  "action.rebind_new_code": { en: "Revoke and print new sticker", es: "Revocar e imprimir etiqueta nueva" },
  "action.delete": { en: "Delete item", es: "Eliminar la cosa" },
  "action.delete_confirm": { en: "The item is hidden from the list. Continue?", es: "La cosa se oculta de la lista. ¿Seguir?" },
  "action.restore": { en: "Restore item", es: "Restaurar la cosa" },
  "action.new_with_new_code": { en: "New item with a new code", es: "Cosa nueva con un código nuevo" },
  "action.photo_saved": { en: "Photo saved.", es: "Foto guardada." },
  "action.photo_removed": { en: "Photo deleted.", es: "Foto borrada." },

  "list.search_placeholder": { en: "Search", es: "Buscar" },
  "list.filter_category": { en: "Category", es: "Categoría" },
  "list.filter_status": { en: "Status", es: "Estado" },
  "list.filter_all": { en: "All", es: "Todo" },
  "list.clean": { en: "Clear", es: "Limpiar" },
  "list.empty": { en: "No items yet.", es: "Todavía no hay cosas." },
  "list.empty_member": { en: "Print stickers and start with the shelves.", es: "Imprime etiquetas y empieza por los estantes." },
  "list.range": { en: "{from}–{to} of {total}", es: "{from}–{to} de {total}" },
  "list.prev": { en: "Previous", es: "Anterior" },
  "list.next": { en: "Next", es: "Siguiente" },
  "list.scan_hint": { en: "Scan a sticker", es: "Escanea una etiqueta" },

  "codes.title": { en: "Print stickers", es: "Imprimir etiquetas" },
  "codes.count": { en: "How many?", es: "¿Cuántas?" },
  "codes.new_sheet": { en: "New sheet", es: "Hoja nueva" },
  "codes.generate": { en: "Generate sheet", es: "Generar la hoja" },
  "codes.view": { en: "Show sheet", es: "Ver la hoja" },
  "codes.print": { en: "Print", es: "Imprimir" },
  "codes.download_svg": { en: "Download SVG", es: "Descargar SVG" },
  "codes.download_sticker": { en: "Download this sticker", es: "Descargar esta etiqueta" },
  "codes.sticker_text": { en: "Sticker {code}", es: "Etiqueta {code}" },

  "err.csrf": {
    en: "Your session ended or the form expired. Log in again and retry.",
    es: "Tu sesión terminó o el formulario venció. Inicia sesión de nuevo e inténtalo otra vez.",
  },
  "err.rate_limited": { en: "Too many requests. Wait a minute.", es: "Demasiadas solicitudes. Espera un minuto." },
  "err.code_taken": {
    en: "This sticker is already used by another item.",
    es: "Esta etiqueta ya está usada por otra cosa.",
  },
  "err.code_invalid": { en: "That code is not valid.", es: "Ese código no es válido." },
  "err.field_required": { en: "Required", es: "Obligatorio" },
  "err.qty_range": { en: "Quantity must be between 0 and 100000.", es: "La cantidad tiene que estar entre 0 y 100000." },
  "err.not_found": { en: "Page not found.", es: "No se encontró la página." },
  "err.range": { en: "Out of range.", es: "Fuera de rango." },
  "scan.readonly_title": { en: "Sticker not registered", es: "Etiqueta sin registrar" },
  "err.forbidden": { en: "Your account can read but not change the inventory.", es: "Tu cuenta puede leer pero no modificar el inventario." },
  "err.internal": { en: "Something failed on the server. Try again.", es: "Algo falló en el servidor. Inténtalo de nuevo." },
  "err.bad_photo": {
    en: "That file is not a JPEG, PNG or WebP image.",
    es: "Ese archivo no es una imagen JPEG, PNG o WebP.",
  },
  "err.photo_too_big": { en: "The photo is larger than 8 MB.", es: "La foto pesa más de 8 MB." },
  "err.photo_limit": {
    en: "That item already has the maximum number of photos.",
    es: "Esa cosa ya tiene el máximo de fotos.",
  },

  "footer.made_by": { en: "for the hacklab, with no dependencies", es: "para el hacklab, sin dependencias" },
};

/** t('key', {name: 'x'}) with placeholders written as {name} in the strings. */
export function makeT(lang) {
  return function t(key, vars) {
    const entry = STRINGS[key];
    if (!entry) throw new Error(`unknown i18n key: ${key}`);
    let s = entry[lang] ?? entry[DEFAULT_LANG];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

/** §9.1: cookie wins, then Accept-Language for `es`, else English. */
export function pickLang(langCookie, acceptLanguage) {
  if (LANGS.includes(langCookie)) return langCookie;
  const preferred = String(acceptLanguage || "")
    .split(",")
    .map((part) => part.trim().split(";")[0])
    .filter(Boolean);
  for (const tag of preferred) {
    if (/^es\b/i.test(tag)) return "es";
  }
  return DEFAULT_LANG;
}
