# Consent & disclaimer copy (in-app)

Two distinct gates. (1) is already implemented (first-launch medical consent in `ui/SafetyScreens.kt`). (2) is the **additional** consent required before turning on **Hosted cloud sync** (GDPR Art. 9 explicit consent) — wire it to the Hosted toggle when you activate the Hosted tier (see `docs/ACTIVATION.md`).

---

## 1. Recurring safety disclaimer (already shipped)

Shown under every AI suggestion + as a periodic modal. For reference, the live text:

- **FR:** « Estimation à vérifier avec ton lecteur et ton médecin — ne suis pas l'IA aveuglément. »
- **ES:** « Estimación a verificar con tu medidor y tu médico — no sigas a la IA a ciegas. »
- **EN:** "An estimate to check against your meter and your doctor — don't follow the AI blindly."

Periodic reminder (weekly):
- **FR:** « Doctor Claude t'aide, mais il peut se tromper. Recoupe toujours ses conseils avec ton lecteur de glycémie et ton ressenti. Pour tout changement important de doses ou de ratios, parle-en à ton médecin. Tu gardes le dernier mot. »
- **EN:** "Doctor Claude helps, but it can be wrong. Always cross-check its advice with your meter and how you feel. For any important change to doses or ratios, talk to your doctor. You keep the final say."

---

## 2. Hosted cloud-sync consent (to wire when activating Hosted)

Checkbox-gated. The user must tick the box before cloud sync turns on.

### Français
**Titre :** Activer la synchronisation cloud (Hosted)

**Corps :**
« En activant le mode Hosted, tu acceptes que tes données de glycémie et tes journaux (repas, insuline, activité) soient synchronisés et conservés sur nos serveurs sous forme **pseudonyme** (un identifiant haché, **jamais ton nom**), afin de fournir l'historique long terme, la synchro multi-appareils et la voix premium.

La glycémie est une donnée de santé sensible (RGPD, article 9). Le traitement repose sur ton **consentement explicite**, que tu peux retirer à tout moment en désactivant le mode Hosted ou en utilisant « Supprimer mes données ». Détails : politique de confidentialité.

En mode Gratuit, rien ne quitte ton téléphone. »

**Case à cocher :** « J'ai lu la politique de confidentialité et je consens à la synchronisation cloud pseudonyme de mes données de santé. »
**Bouton :** ACTIVER LA SYNCHRO · **Lien :** Politique de confidentialité · **Annuler**

### English
**Title:** Enable cloud sync (Hosted)

**Body:**
"By turning on Hosted mode, you agree that your glucose data and your logs (meals, insulin, activity) are synced and stored on our servers in **pseudonymous** form (a hashed id, **never your name**), to provide long-term history, multi-device sync, and premium voice.

Glucose is special-category health data (GDPR, Article 9). Processing is based on your **explicit consent**, which you can withdraw at any time by turning off Hosted mode or using 'Delete my data'. Details: privacy policy.

In Free mode, nothing leaves your phone."

**Checkbox:** "I have read the privacy policy and I consent to pseudonymous cloud sync of my health data."
**Button:** ENABLE SYNC · **Link:** Privacy policy · **Cancel**

### Español
**Título:** Activar la sincronización en la nube (Hosted)

**Cuerpo:**
"Al activar el modo Hosted, aceptas que tus datos de glucosa y tus registros (comidas, insulina, actividad) se sincronicen y guarden en nuestros servidores de forma **seudónima** (un identificador con hash, **nunca tu nombre**), para ofrecer el historial a largo plazo, la sincronización entre dispositivos y la voz premium.

La glucosa es un dato de salud sensible (RGPD, artículo 9). El tratamiento se basa en tu **consentimiento explícito**, que puedes retirar en cualquier momento desactivando el modo Hosted o usando 'Eliminar mis datos'. Detalles: política de privacidad.

En modo Gratis, nada sale de tu teléfono."

**Casilla:** "He leído la política de privacidad y consiento la sincronización seudónima en la nube de mis datos de salud."
**Botón:** ACTIVAR SINCRONIZACIÓN · **Enlace:** Política de privacidad · **Cancelar**

---

## "Delete my data" (Hosted)

Button in Profil. Confirms, then calls a delete endpoint that removes all rows for the user's subject hash (readings, coach_log, meals, insulin, activity, profile). Show a success toast: FR « Tes données ont été supprimées. » / EN "Your data has been deleted." / ES "Tus datos han sido eliminados."
