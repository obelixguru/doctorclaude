// User-facing strings, ported verbatim from the Android app's `ui/Localization.kt` so the two
// clients speak with one voice — the family should not be able to tell which screen they are on.
//
// FR and ES only, exactly like the app (`enum class Lang { FR, ES }`). Dynamic AI text and the
// spoken replies are NOT here: those are localised server-side from the `lang` field sent with each
// coach/ask/scan call, which is why every request below carries it.
//
// The Kotlin side pays a dex penalty for a 252-property interface (Localization.kt:806-838) and has
// to shard new strings into a second holder. A plain object has no such ceiling, so keys are added
// here freely — but a key MUST exist in both languages, same as the app's rule.

const FR = {
  sensor: "Capteur FreeStyle", current: "ACTUEL", updated: "MAJ", waiting: "En attente de mesures…",
  average: "MOYENNE", target: "CIBLE", statHigh: "% HAUT", statLow: "% BAS",
  periodLast24h: "DERNIÈRES 24 H", periodOverDays: "%d DERNIERS JOURS", deviation: "ÉCART",
  history: "HISTORIQUE", talk: "PARLER", momTitle: "DOCTOR CLAUDE", analyze: "ANALYSE",
  listening: "J'ÉCOUTE…", statusHigh: "ÉLEVÉ", statusLow: "BAS", statusInRange: "DANS LA CIBLE",

  loginSubtitle: "Connectez votre compte LibreLinkUp", emailLabel: "Email LibreLinkUp",
  passwordLabel: "Mot de passe", connect: "Se connecter", connecting: "Connexion…",
  howItWorks: "Comment ça marche",
  howItWorksBody: "Utilisez votre compte LibreLinkUp (app suiveur Abbott). Le porteur du capteur doit utiliser LibreLink (app patient) et avoir partagé son flux avec ce compte. Données toutes les minutes via le cloud Abbott — pas de NFC, pas d'app tierce.",
  loginBad: "Identifiants invalides.", loginRate: "LibreLinkUp limite temporairement les requêtes. Rien de cassé — les données reprennent toutes seules dans quelques minutes.",
  loginFail: "Connexion impossible. Vérifie le réseau et réessaie.", logout: "SE DÉCONNECTER",

  trendFallingFast: "Chute rapide", trendFalling: "Baisse", trendStable: "Stable",
  trendRising: "Hausse", trendRisingFast: "Montée rapide",

  tabGlucose: "Glycémie", tabMeals: "Repas", tabInsulin: "Insuline", tabHistory: "Historique",
  tabProfile: "Profil",

  profileTitle: "PROFIL",
  profileIntro: "Donne l'essentiel — Dr Claude estime tes réglages d'insuline (à valider avec le médecin).",
  fieldNickname: "Surnom", fieldAge: "Âge", fieldWeight: "Poids (kg)",
  fieldDxYears: "Diabétique depuis (années)", fieldRapidName: "Insuline rapide (nom)",
  fieldRapidUnits: "Rapide u/jour", fieldBasalName: "Insuline lente (nom)",
  fieldBasalUnits: "Lente u/jour", fieldNotes: "Notes (allergies, sport…)",
  saveProfile: "ENREGISTRER", autoSaving: "Enregistrement…", profileSaved: "Profil enregistré",
  ratiosEstimated: "Réglages estimés par Dr Claude (à valider avec le médecin)",
  ratiosDoctor: "Réglages donnés par ton médecin",
  fieldCarbRatio: "Ratio glucides (1 u pour X g)", fieldCorrection: "Facteur de correction (1 u baisse de X)",
  fieldTarget: "Glycémie cible (mg/dL)",

  foodTitle: "REPAS", foodDescHint: "Qu'a-t-il mangé / va manger ?",
  foodCarbsHint: "Glucides (g) — laisse vide, l'IA estime",
  foodQtyHint: "Quantité (× combien de fois)", foodQtyTotal: "= %d g au total",
  foodAdd: "AJOUTER", foodPlan: "JE VAIS MANGER", foodAddTitle: "Ajouter un repas",
  foodVoiceHint: "Astuce : touche le micro et dis « je vais boire un coca » — Dr Claude l'ajoute ici et estime la dose.",
  foodEmpty: "Aucun repas pour l'instant.", foodPlanned: "prévu", foodEaten: "mangé",
  foodDelete: "Supprimer", foodDeleteConfirm: "Supprimer ce repas ?",
  foodScan: "SCAN PRODUIT", foodScanShort: "SCAN", foodGalleryShort: "GALERIE",
  foodScanning: "Analyse de la photo…", foodScanFail: "Photo illisible, réessaie.",
  foodSaving: "Enregistrement…", foodSaved: "Repas enregistré",

  insulinTitle: "INSULINE", insulinAddTitle: "Ajouter une injection",
  insulinTabDoses: "DOSES", insulinTabSettings: "RÉGLAGES",
  insulinRapidTag: "rapide", insulinSlowTag: "lente",
  insulinUnitsHint: "Unités", insulinNameHint: "Nom de l'insuline (optionnel)",
  insulinEmpty: "Aucune injection enregistrée.", insulinDeleteConfirm: "Supprimer cette injection ?",
  insulinSaved: "Injection enregistrée",

  seeAllHistory: "VOIR TOUT L'HISTORIQUE", filterAll: "Tout", historyScreenTitle: "HISTORIQUE",
  generalTab: "GÉNÉRAL", pastAnalyses: "ANALYSES", injections: "INJECTIONS",
  historyEmpty: "Rien à afficher pour l'instant.", back: "Retour",

  alertLow: "GLYCÉMIE BASSE", alertHigh: "GLYCÉMIE HAUTE",
  alertActLow: "Prends du sucre maintenant.", alertActHigh: "Dr Claude regarde s'il faut corriger.",
  alertStop: "ARRÊTER L'ALARME",

  signalLost: "Signal perdu — dernière mesure il y a", noSignal: "NO SIGNAL",
  noSignalSub: "Aucun signal du capteur. Reconnecte-le (rapproche le téléphone qui le scanne, re-scanne). S'il ne revient pas, fais un test au doigt — ne te fie pas au dernier chiffre.",
  graphHidden: "Graphe masqué — pas de mesure récente.", noSignalShort: "Pas de signal",
  sensorExpired: "CAPTEUR EXPIRÉ",

  consentTitle: "À lire avant de commencer",
  consentBody: "Dr Claude est un assistant, pas un dispositif médical, et il peut se tromper.\n\nSes conseils — doses d'insuline, resucrage, analyses — sont des ESTIMATIONS, à vérifier avec ton lecteur de glycémie et, en cas de doute, ton médecin.\n\nNe suis jamais un conseil aveuglément : recoupe-le avec ton ressenti. Pour tout changement important (doses, ratios), parle-en à un professionnel de santé.\n\nC'est toi qui gardes le dernier mot sur ton traitement, et tu en restes responsable.",
  consentCheck: "J'ai lu et compris : Dr Claude n'est pas un médecin et peut se tromper.",
  consentAccept: "J'AI COMPRIS ET J'ACCEPTE",
  doseDisclaimer: "Estimation à vérifier avec ton lecteur et ton médecin — ne suis pas l'IA aveuglément.",
  safetyTitle: "Petit rappel de sécurité",
  safetyBody: "Dr Claude t'aide, mais il peut se tromper. Recoupe toujours ses conseils avec ton lecteur de glycémie et ton ressenti. Pour tout changement important de doses ou de ratios, parle-en à ton médecin. Tu gardes le dernier mot.",
  safetyOk: "COMPRIS",

  notifCardTitle: "Notifications & alarmes",
  notifCardSub: "Volume, vibreur, heures calmes, types d'alertes",
  notifPageTitle: "Notifications & alarmes", notifModeTitle: "Son & vibration",
  notifModeSound: "Son + vibration", notifModeSilent: "Silencieux",
  notifVolumeLabel: "Volume de l'alarme", notifTestBtn: "Tester l'alarme",
  notifQuietTitle: "Heures calmes (école / nuit)", notifQuietLabel: "Activer les heures calmes",
  notifQuietSub: "Pendant cette plage, l'hyper est silencieuse. L'hypo, elle, continue de sonner (réglable ci-dessous). Le parent reçoit aussi l'alerte Telegram.",
  notifQuietFrom: "De", notifQuietTo: "à", notifTypesTitle: "Types d'alertes",
  notifHyperLabel: "Glycémie haute (hyper)", notifHyperSub: "Alerte au-dessus de 180 mg/dL",
  notifHypoLabel: "Glycémie basse (hypo)", notifHypoSub: "Alerte en dessous de 70 mg/dL",
  notifHypoWarn: "⚠️ Couper l'alarme d'hypo est risqué — ne le fais que si tu surveilles autrement.",
  notifHypoAlwaysLabel: "Hypo sonne quand même",
  notifHypoAlwaysSub: "Une glycémie basse sonne même pendant les heures calmes (recommandé pour un enfant).",
  notifTelegramNote: "Le parent reçoit aussi une alerte Telegram, indépendante de ce téléphone et de ces réglages.",
  notifWebLimit: "⚠️ Un site web ne peut sonner que s'il est OUVERT à l'écran. Ce n'est PAS une alarme de fond : le filet de sécurité reste l'alerte Telegram, qui arrive même téléphone rangé.",

  predictTitle: "ANTICIPATION",
  askPlaceholder: "Pose ta question à Dr Claude…", askSend: "DEMANDER", askThinking: "Dr Claude réfléchit…",
  voiceLabel: "Voix de Dr Claude", voiceSub: "Lecture audio des analyses et réponses",
  voiceStop: "STOP", voicePlaying: "Lecture en cours…",
  online: "En ligne", offline: "Hors ligne",
  cancel: "Annuler", confirm: "Confirmer", save: "Enregistrer", del: "Supprimer",
  loading: "Chargement…", errorGeneric: "Une erreur est survenue. Réessaie.",
  serverUnreachable: "Impossible de joindre le serveur — les chiffres affichés ne sont pas à jour. Vérifie la connexion ; en cas de doute, fais un test au doigt.",
  whenNow: "maintenant", whenAgo: "il y a %d min", whenIn: "dans %d min",
  patientPick: "Qui suit-on ?", language: "Langue",
  autotuneTitle: "AMÉLIORER LES RÉGLAGES",
  autotuneSub: "Dr Claude regarde tes injections des derniers jours et propose des réglages plus justes. À valider avec le médecin.",
  autotuneBtn: "PROPOSER UN RÉGLAGE", autotuneApply: "UTILISER CES RÉGLAGES",
  installTitle: "Installer sur l'écran d'accueil",
  installBody: "Dans Safari : touche le bouton Partager, puis « Sur l'écran d'accueil ». L'app s'ouvre alors en plein écran, sans la barre du navigateur.",
};

const ES = {
  sensor: "Sensor FreeStyle", current: "ACTUAL", updated: "ACT", waiting: "Esperando mediciones…",
  average: "PROMEDIO", target: "OBJETIVO", statHigh: "% ALTO", statLow: "% BAJO",
  periodLast24h: "ÚLTIMAS 24 H", periodOverDays: "ÚLTIMOS %d DÍAS", deviation: "DESVÍO",
  history: "HISTORIAL", talk: "HABLAR", momTitle: "DOCTOR CLAUDE", analyze: "ANÁLISIS",
  listening: "TE ESCUCHO…", statusHigh: "ALTO", statusLow: "BAJO", statusInRange: "EN OBJETIVO",

  loginSubtitle: "Conecta tu cuenta LibreLinkUp", emailLabel: "Email LibreLinkUp",
  passwordLabel: "Contraseña", connect: "Conectar", connecting: "Conectando…",
  howItWorks: "Cómo funciona",
  howItWorksBody: "Usa tu cuenta LibreLinkUp (app seguidor de Abbott). El portador del sensor debe usar LibreLink (app paciente) y haber compartido sus datos con esta cuenta. Datos cada minuto vía la nube de Abbott — sin NFC, sin apps de terceros.",
  loginBad: "Credenciales inválidas.", loginRate: "LibreLinkUp limita temporalmente las peticiones. Nada roto — los datos vuelven solos en unos minutos.",
  loginFail: "No se pudo conectar. Revisa la red e inténtalo de nuevo.", logout: "CERRAR SESIÓN",

  trendFallingFast: "Bajada rápida", trendFalling: "Bajando", trendStable: "Estable",
  trendRising: "Subiendo", trendRisingFast: "Subida rápida",

  tabGlucose: "Glucosa", tabMeals: "Comidas", tabInsulin: "Insulina", tabHistory: "Historial",
  tabProfile: "Perfil",

  profileTitle: "PERFIL",
  profileIntro: "Da lo esencial — Dr Claude estima tus ajustes de insulina (a validar con el médico).",
  fieldNickname: "Apodo", fieldAge: "Edad", fieldWeight: "Peso (kg)",
  fieldDxYears: "Diabético desde (años)", fieldRapidName: "Insulina rápida (nombre)",
  fieldRapidUnits: "Rápida u/día", fieldBasalName: "Insulina lenta (nombre)",
  fieldBasalUnits: "Lenta u/día", fieldNotes: "Notas (alergias, deporte…)",
  saveProfile: "GUARDAR", autoSaving: "Guardando…", profileSaved: "Perfil guardado",
  ratiosEstimated: "Ajustes estimados por Dr Claude (a validar con el médico)",
  ratiosDoctor: "Ajustes dados por tu médico",
  fieldCarbRatio: "Ratio de carbos (1 u por X g)", fieldCorrection: "Factor de corrección (1 u baja X)",
  fieldTarget: "Glucosa objetivo (mg/dL)",

  foodTitle: "COMIDAS", foodDescHint: "¿Qué comió / va a comer?",
  foodCarbsHint: "Carbos (g) — déjalo vacío, la IA estima",
  foodQtyHint: "Cantidad (× cuántas veces)", foodQtyTotal: "= %d g en total",
  foodAdd: "AÑADIR", foodPlan: "VOY A COMER", foodAddTitle: "Añadir una comida",
  foodVoiceHint: "Truco: toca el micrófono y di « voy a beber una Coca » — Dr Claude lo añade aquí y estima la dosis.",
  foodEmpty: "Sin comidas por ahora.", foodPlanned: "previsto", foodEaten: "comido",
  foodDelete: "Eliminar", foodDeleteConfirm: "¿Eliminar esta comida?",
  foodScan: "ESCANEAR PRODUCTO", foodScanShort: "ESCANEAR", foodGalleryShort: "GALERÍA",
  foodScanning: "Analizando la foto…", foodScanFail: "Foto ilegible, reinténtalo.",
  foodSaving: "Guardando…", foodSaved: "Comida guardada",

  insulinTitle: "INSULINA", insulinAddTitle: "Añadir una inyección",
  insulinTabDoses: "DOSIS", insulinTabSettings: "AJUSTES",
  insulinRapidTag: "rápida", insulinSlowTag: "lenta",
  insulinUnitsHint: "Unidades", insulinNameHint: "Nombre de la insulina (opcional)",
  insulinEmpty: "Sin inyecciones registradas.", insulinDeleteConfirm: "¿Eliminar esta inyección?",
  insulinSaved: "Inyección guardada",

  seeAllHistory: "VER TODO EL HISTORIAL", filterAll: "Todo", historyScreenTitle: "HISTORIAL",
  generalTab: "GENERAL", pastAnalyses: "ANÁLISIS", injections: "INYECCIONES",
  historyEmpty: "Nada que mostrar por ahora.", back: "Volver",

  alertLow: "GLUCOSA BAJA", alertHigh: "GLUCOSA ALTA",
  alertActLow: "Toma azúcar ahora.", alertActHigh: "Dr Claude mira si hay que corregir.",
  alertStop: "PARAR LA ALARMA",

  signalLost: "Señal perdida — última medición hace", noSignal: "SIN SEÑAL",
  noSignalSub: "Sin señal del sensor. Reconéctalo (acerca el teléfono que lo escanea, vuelve a escanear). Si no vuelve, hazte una prueba de dedo — no te fíes del último número.",
  graphHidden: "Gráfico oculto — sin mediciones recientes.", noSignalShort: "Sin señal",
  sensorExpired: "SENSOR CADUCADO",

  consentTitle: "Léelo antes de empezar",
  consentBody: "Dr Claude es un asistente, no un dispositivo médico, y puede equivocarse.\n\nSus consejos — dosis de insulina, azúcar de rescate, análisis — son ESTIMACIONES, a verificar con tu medidor de glucosa y, en caso de duda, tu médico.\n\nNunca sigas un consejo a ciegas: contrástalo con lo que sientes. Para cualquier cambio importante (dosis, ratios), háblalo con un profesional sanitario.\n\nLa última palabra sobre tu tratamiento es tuya, y sigues siendo responsable de ella.",
  consentCheck: "He leído y entendido: Dr Claude no es un médico y puede equivocarse.",
  consentAccept: "LO ENTIENDO Y ACEPTO",
  doseDisclaimer: "Estimación a verificar con tu medidor y tu médico — no sigas a la IA a ciegas.",
  safetyTitle: "Recordatorio de seguridad",
  safetyBody: "Dr Claude te ayuda, pero puede equivocarse. Contrasta siempre sus consejos con tu medidor de glucosa y con lo que sientes. Para cualquier cambio importante de dosis o de ratios, háblalo con tu médico. Tú tienes la última palabra.",
  safetyOk: "ENTENDIDO",

  notifCardTitle: "Notificaciones y alarmas",
  notifCardSub: "Volumen, vibración, horas tranquilas, tipos de alerta",
  notifPageTitle: "Notificaciones y alarmas", notifModeTitle: "Sonido y vibración",
  notifModeSound: "Sonido + vibración", notifModeSilent: "Silencioso",
  notifVolumeLabel: "Volumen de la alarma", notifTestBtn: "Probar la alarma",
  notifQuietTitle: "Horas tranquilas (colegio / noche)", notifQuietLabel: "Activar las horas tranquilas",
  notifQuietSub: "Durante este intervalo, la hiper es silenciosa. La hipo, en cambio, sigue sonando (ajustable abajo). El padre también recibe la alerta de Telegram.",
  notifQuietFrom: "De", notifQuietTo: "a", notifTypesTitle: "Tipos de alerta",
  notifHyperLabel: "Glucosa alta (hiper)", notifHyperSub: "Alerta por encima de 180 mg/dL",
  notifHypoLabel: "Glucosa baja (hipo)", notifHypoSub: "Alerta por debajo de 70 mg/dL",
  notifHypoWarn: "⚠️ Apagar la alarma de hipo es arriesgado — hazlo solo si vigilas de otra forma.",
  notifHypoAlwaysLabel: "La hipo suena igualmente",
  notifHypoAlwaysSub: "Una glucosa baja suena incluso durante las horas tranquilas (recomendado para un niño).",
  notifTelegramNote: "El padre también recibe una alerta de Telegram, independiente de este teléfono y de estos ajustes.",
  notifWebLimit: "⚠️ Una web solo puede sonar si está ABIERTA en pantalla. NO es una alarma de fondo: la red de seguridad sigue siendo la alerta de Telegram, que llega con el teléfono guardado.",

  predictTitle: "ANTICIPACIÓN",
  askPlaceholder: "Haz tu pregunta a Dr Claude…", askSend: "PREGUNTAR", askThinking: "Dr Claude está pensando…",
  voiceLabel: "Voz de Dr Claude", voiceSub: "Lectura en voz alta de análisis y respuestas",
  voiceStop: "PARAR", voicePlaying: "Reproduciendo…",
  online: "En línea", offline: "Sin conexión",
  cancel: "Cancelar", confirm: "Confirmar", save: "Guardar", del: "Eliminar",
  loading: "Cargando…", errorGeneric: "Ha ocurrido un error. Inténtalo de nuevo.",
  serverUnreachable: "No se puede contactar con el servidor — las cifras mostradas no están actualizadas. Revisa la conexión; ante la duda, hazte una prueba de dedo.",
  whenNow: "ahora", whenAgo: "hace %d min", whenIn: "en %d min",
  patientPick: "¿A quién seguimos?", language: "Idioma",
  autotuneTitle: "MEJORAR LOS AJUSTES",
  autotuneSub: "Dr Claude mira tus inyecciones de los últimos días y propone ajustes más precisos. A validar con el médico.",
  autotuneBtn: "PROPONER UN AJUSTE", autotuneApply: "USAR ESTOS AJUSTES",
  installTitle: "Instalar en la pantalla de inicio",
  installBody: "En Safari: toca el botón Compartir y luego « Añadir a pantalla de inicio ». La app se abrirá a pantalla completa, sin la barra del navegador.",
};

const TABLES = { fr: FR, es: ES };

let current = "fr";

export function setLang(code) {
  current = code === "es" ? "es" : "fr";
}

export const getLang = () => current;

/**
 * Look up a string, substituting a single %d/%s placeholder when an argument is given.
 *
 * A missing key returns the key itself rather than blank or "undefined": a gap shows up as an
 * obvious token in the UI instead of a hole that reads like a rendering bug.
 */
export function t(key, arg) {
  const s = TABLES[current][key] ?? FR[key] ?? key;
  return arg === undefined ? s : s.replace(/%[ds]/, String(arg));
}
