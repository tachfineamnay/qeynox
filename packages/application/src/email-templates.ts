/**
 * MISSION A19 — transactional and notification e-mail templates.
 *
 * Template rendering is pure and dependency-free: no I/O, no clock, no globals. Everything variable
 * is escaped before interpolation into HTML; plain text never escapes (it is not markup).
 *
 * Locales: English and French ship complete. The registry is deliberately data-driven so Spanish
 * and German are additive entries, not code changes; `resolveEmailLocale` falls back to English for
 * any unreviewed locale rather than failing a send. Adding a reviewed es/de catalog requires no
 * structural change — only new rows in `catalogs` below.
 */

export type EmailTemplateId =
  | 'EMAIL_VERIFICATION'
  | 'PASSWORD_RESET'
  | 'WORKSPACE_INVITATION'
  | 'APPROVAL_REQUIRED'
  | 'EXECUTION_FAILED'
  | 'RESULT_DELIVERED';

export type EmailLocale = 'en' | 'fr' | 'es' | 'de';
export const EMAIL_LOCALES: readonly EmailLocale[] = ['en', 'fr', 'es', 'de'];
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

export function resolveEmailLocale(value: string | null | undefined): EmailLocale {
  const short = (value ?? '').trim().toLowerCase().split('-')[0] ?? '';
  return (EMAIL_LOCALES as readonly string[]).includes(short) ? short as EmailLocale : DEFAULT_EMAIL_LOCALE;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface Copy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly cta: string;
  readonly outro: string;
  readonly footer: string;
}

/**
 * One entry per (template, locale). The variable contract per template:
 *   EMAIL_VERIFICATION / PASSWORD_RESET : { link, expiresAt }
 *   WORKSPACE_INVITATION                : { workspaceName, role, actionUrl, expiresAt }
 *   APPROVAL_REQUIRED                   : { operationTitle, actionUrl }
 *   EXECUTION_FAILED                    : { operationTitle, errorCode, actionUrl }
 *   RESULT_DELIVERED                    : { operationTitle, actionUrl }
 */
const catalogs: Record<EmailTemplateId, Record<EmailLocale, Copy>> = {
  EMAIL_VERIFICATION: {
    en: { subject: 'Confirm your QeyNox e-mail address', heading: 'Confirm your e-mail address', intro: 'Open this single-use link to confirm that this address belongs to you:', cta: 'Confirm e-mail address', outro: 'The link expires at {expiresAt}. If you did not create this account, ignore this message.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Confirmez votre adresse e-mail QeyNox', heading: 'Confirmez votre adresse e-mail', intro: 'Ouvrez ce lien à usage unique pour confirmer que cette adresse vous appartient :', cta: 'Confirmer mon adresse e-mail', outro: 'Ce lien expire le {expiresAt}. Si vous êtes à l’origine de ce message par erreur, ignorez-le.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Confirma tu correo de QeyNox', heading: 'Confirma tu correo', intro: 'Abre este enlace de un solo uso para confirmar que esta dirección te pertenece:', cta: 'Confirmar correo', outro: 'El enlace caduca el {expiresAt}. Si no creaste esta cuenta, ignora este mensaje.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Bestätigen Sie Ihre QeyNox-E-Mail-Adresse', heading: 'E-Mail-Adresse bestätigen', intro: 'Öffnen Sie diesen Einmal-Link, um zu bestätigen, dass Ihnen diese Adresse gehört:', cta: 'E-Mail-Adresse bestätigen', outro: 'Der Link läuft am {expiresAt} ab. Falls Sie dieses Konto nicht angelegt haben, ignorieren Sie diese Nachricht.', footer: 'QeyNox — Ergebnisse als Service' },
  },
  PASSWORD_RESET: {
    en: { subject: 'Reset your QeyNox password', heading: 'Reset your password', intro: 'Open this single-use link to choose a new password:', cta: 'Reset password', outro: 'The link expires at {expiresAt}. If you did not request a reset, ignore this message — your password stays unchanged.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Réinitialisez votre mot de passe QeyNox', heading: 'Réinitialisez votre mot de passe', intro: 'Ouvrez ce lien à usage unique pour choisir un nouveau mot de passe :', cta: 'Réinitialiser le mot de passe', outro: 'Ce lien expire le {expiresAt}. Si vous n’avez pas demandé de réinitialisation, ignorez ce message — votre mot de passe reste inchangé.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Restablece tu contraseña de QeyNox', heading: 'Restablece tu contraseña', intro: 'Abre este enlace de un solo uso para elegir una contraseña nueva:', cta: 'Restablecer contraseña', outro: 'El enlace caduca el {expiresAt}. Si no solicitaste un restablecimiento, ignora este mensaje — tu contraseña no cambia.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Setzen Sie Ihr QeyNox-Passwort zurück', heading: 'Passwort zurücksetzen', intro: 'Öffnen Sie diesen Einmal-Link, um ein neues Passwort zu wählen:', cta: 'Passwort zurücksetzen', outro: 'Der Link läuft am {expiresAt} ab. Wenn Sie kein Zurücksetzen angefordert haben, ignorieren Sie diese Nachricht — Ihr Passwort bleibt unverändert.', footer: 'QeyNox — Ergebnisse als Service' },
  },
  WORKSPACE_INVITATION: {
    en: { subject: 'You were invited to the QeyNox workspace “{workspaceName}”', heading: 'Workspace invitation', intro: 'You were invited to join the workspace “{workspaceName}” as {role}. Sign in to your account to accept or decline the invitation:', cta: 'Review invitation', outro: 'The invitation expires at {expiresAt}. If you were not expecting this, you can ignore this message.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Vous êtes invité·e à l’espace QeyNox « {workspaceName} »', heading: 'Invitation à un espace de travail', intro: 'Vous êtes invité·e à rejoindre l’espace « {workspaceName} » en tant que {role}. Connectez-vous à votre compte pour accepter ou refuser l’invitation :', cta: 'Voir l’invitation', outro: 'L’invitation expire le {expiresAt}. Si vous n’attendiez pas ce message, vous pouvez l’ignorer.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Te han invitado al espacio QeyNox «{workspaceName}»', heading: 'Invitación a un espacio de trabajo', intro: 'Te han invitado a unirte al espacio «{workspaceName}» como {role}. Inicia sesión en tu cuenta para aceptar o rechazar la invitación:', cta: 'Ver invitación', outro: 'La invitación caduca el {expiresAt}. Si no esperabas este mensaje, puedes ignorarlo.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Sie wurden in den QeyNox-Arbeitsbereich „{workspaceName}“ eingeladen', heading: 'Arbeitsbereich-Einladung', intro: 'Sie wurden eingeladen, dem Arbeitsbereich „{workspaceName}“ als {role} beizutreten. Melden Sie sich in Ihrem Konto an, um die Einladung anzunehmen oder abzulehnen:', cta: 'Einladung ansehen', outro: 'Die Einladung läuft am {expiresAt} ab. Falls Sie damit nicht gerechnet haben, können Sie diese Nachricht ignorieren.', footer: 'QeyNox — Ergebnisse als Service' },
  },
  APPROVAL_REQUIRED: {
    en: { subject: 'Your review is required: “{operationTitle}”', heading: 'A result awaits your review', intro: 'All steps for “{operationTitle}” are complete and a result review is pending. Open the mission to approve or reject the deliverable:', cta: 'Open the mission', outro: 'Until the review is decided, the result is not delivered to anyone.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Votre revue est requise : « {operationTitle} »', heading: 'Un résultat attend votre revue', intro: 'Toutes les étapes de « {operationTitle} » sont terminées et une revue de résultat est en attente. Ouvrez la mission pour approuver ou rejeter le livrable :', cta: 'Ouvrir la mission', outro: 'Tant que la revue n’est pas tranchée, le résultat n’est livré à personne.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Tu revisión es necesaria: «{operationTitle}»', heading: 'Un resultado espera tu revisión', intro: 'Todos los pasos de «{operationTitle}» están completos y la revisión del resultado está pendiente. Abre la misión para aprobar o rechazar el entregable:', cta: 'Abrir la misión', outro: 'Hasta que se decida la revisión, el resultado no se entrega a nadie.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Ihre Prüfung ist erforderlich: „{operationTitle}“', heading: 'Ein Ergebnis wartet auf Ihre Prüfung', intro: 'Alle Schritte für „{operationTitle}“ sind abgeschlossen, die Ergebnissichtung steht aus. Öffnen Sie die Mission, um das Ergebnis freizugeben oder abzulehnen:', cta: 'Mission öffnen', outro: 'Bis zur Entscheidung der Prüfung wird das Ergebnis an niemanden ausgeliefert.', footer: 'QeyNox — Ergebnisse als Service' },
  },
  EXECUTION_FAILED: {
    en: { subject: 'A step could not be completed: “{operationTitle}”', heading: 'Execution failed', intro: 'A step of “{operationTitle}” stopped with the code {errorCode}. The operator can see the same code; nothing is marked as delivered or complete:', cta: 'Open the mission', outro: 'If the failure is transient, retrying the mission may resolve it. Budget exhaustion is a policy stop: raising the budget is the operator’s action, not an automatic retry.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Une étape n’a pas pu être finalisée : « {operationTitle} »', heading: 'L’exécution a échoué', intro: 'Une étape de « {operationTitle} » s’est arrêtée avec le code {errorCode}. L’opérateur voit le même code ; rien n’est marqué comme livré ou terminé :', cta: 'Ouvrir la mission', outro: 'Si l’échec est transitoire, relancer la mission peut le résoudre. Un budget épuisé est un arrêt de politique : relever le budget relève de l’opérateur, pas d’une relance automatique.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Un paso no se pudo completar: «{operationTitle}»', heading: 'La ejecución falló', intro: 'Un paso de «{operationTitle}» se detuvo con el código {errorCode}. El operador ve el mismo código; nada se marca como entregado o completado:', cta: 'Abrir la misión', outro: 'Si el fallo es transitorio, reintentar la misión puede resolverlo. Si se agotó el presupuesto, es una parada de política: elevar el presupuesto es acción del operador, no un reintento automático.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Ein Schritt konnte nicht abgeschlossen werden: „{operationTitle}“', heading: 'Ausführung fehlgeschlagen', intro: 'Ein Schritt von „{operationTitle}“ wurde mit dem Code {errorCode} angehalten. Der Betreiber sieht denselben Code; nichts wird als zugestellt oder abgeschlossen markiert:', cta: 'Mission öffnen', outro: 'Bei einem vorübergehenden Fehler kann ein erneuter Versuch der Mission helfen. Bei erschöpftem Budget handelt es sich um einen Policy-Stopp: Das Anheben des Budgets ist Aufgabe des Betreibers, kein automatischer Wiederholungsversuch.', footer: 'QeyNox — Ergebnisse als Service' },
  },
  RESULT_DELIVERED: {
    en: { subject: 'Your deliverable is ready: “{operationTitle}”', heading: 'Result delivered', intro: 'The reviewed deliverable for “{operationTitle}” has been released. Open the mission to read it and its evidence:', cta: 'Read the result', outro: 'The evidence cited in the document is available from the mission page.', footer: 'QeyNox — Results as a Service' },
    fr: { subject: 'Votre livrable est prêt : « {operationTitle} »', heading: 'Résultat livré', intro: 'Le livrable revu pour « {operationTitle} » a été publié. Ouvrez la mission pour le consulter et voir ses preuves :', cta: 'Lire le résultat', outro: 'Les preuves citées dans le document sont disponibles depuis la page de la mission.', footer: 'QeyNox — Le résultat en tant que service' },
    es: { subject: 'Tu entregable está listo: «{operationTitle}»', heading: 'Resultado entregado', intro: 'El entregable revisado de «{operationTitle}» ha sido publicado. Abre la misión para leerlo y ver sus evidencias:', cta: 'Leer el resultado', outro: 'Las evidencias citadas en el documento están disponibles en la página de la misión.', footer: 'QeyNox — Resultados como servicio' },
    de: { subject: 'Ihr Ergebnisdokument ist fertig: „{operationTitle}“', heading: 'Ergebnis zugestellt', intro: 'Das geprüfte Ergebnisdokument für „{operationTitle}“ wurde freigegeben. Öffnen Sie die Mission, um es mit seinen Belegen zu lesen:', cta: 'Ergebnis lesen', outro: 'Die im Dokument zitierten Belege sind auf der Missionsseite abrufbar.', footer: 'QeyNox — Ergebnisse als Service' },
  },
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const interpolate = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key: string) => vars[key] ?? '');

/** Renders one template in one locale. Unknown locales fall back to English; unknown vars render as empty. */
export function renderEmail(templateId: EmailTemplateId, locale: string | null | undefined, vars: Record<string, string>): RenderedEmail {
  const lang = resolveEmailLocale(locale);
  const copyEntry = catalogs[templateId][lang];
  const subject = interpolate(copyEntry.subject, vars);
  const heading = interpolate(copyEntry.heading, vars);
  const intro = interpolate(copyEntry.intro, vars);
  const outro = interpolate(copyEntry.outro, vars);
  const actionUrl = vars['actionUrl'] ?? vars['link'] ?? '';
  const text = [heading, '', intro, actionUrl, '', outro, '', copyEntry.footer].join('\n');
  const safeUrl = escapeHtml(actionUrl);
  const html = [
    '<!doctype html><html lang="' + lang + '"><body style="margin:0;padding:0;background:#f2f5fc;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#080c1f">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 20px">',
    '<div style="background:#051231;border-radius:16px;padding:18px 24px;color:#dfeafe"><strong style="font-size:18px;letter-spacing:-0.5px;color:#ffffff">QeyNox</strong></div>',
    '<div style="background:#ffffff;border:1px solid #d8e3f5;border-radius:16px;padding:28px;margin-top:12px">',
    '<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;letter-spacing:-0.3px">' + escapeHtml(heading) + '</h1>',
    '<p style="font-size:15px;line-height:1.6;color:#485673;margin:0 0 18px">' + escapeHtml(intro) + '</p>',
    actionUrl ? '<p style="margin:0 0 18px"><a href="' + safeUrl + '" style="display:inline-block;background:#1054f6;color:#ffffff;text-decoration:none;font-weight:650;padding:12px 20px;border-radius:12px">' + escapeHtml(interpolate(copyEntry.cta, vars)) + '</a></p>' : '',
    '<p style="font-size:15px;line-height:1.6;color:#485673;margin:0 0 0">' + escapeHtml(outro) + '</p>',
    '</div>',
    '<p style="font-size:12px;color:#69758f;margin:16px 4px">' + escapeHtml(copyEntry.footer) + '</p>',
    '</div></body></html>',
  ].join('');
  return { subject, text, html };
}
