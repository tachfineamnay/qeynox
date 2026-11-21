import type { Locale } from './copy';

/** MISSION A21.05 — register page copy (EN/FR). Kept out of component logic. */
export interface RegistrationCopy {
  readonly closedTitle: string;
  readonly closedBody: string;
  readonly unavailableTitle: string;
  readonly unavailableBody: string;
  readonly inviteOnlyTitle: string;
  readonly inviteOnlyNote: string;
  readonly invitationLabel: string;
  readonly invitationHint: string;
  readonly invitationEnrollsHint: string;
  readonly invitationInvalid: string;
  readonly conflict: string;
  readonly closedAtSubmit: string;
  readonly signIn: string;
}

export const registrationCopy: Record<Locale, RegistrationCopy> = {
  en: {
    closedTitle: 'Registration is closed',
    closedBody: 'QeyNox is not accepting new accounts at the moment. No account can be created from this page.',
    unavailableTitle: 'Registration status unavailable',
    unavailableBody: 'We could not confirm whether registration is open, so the form is not shown. Please try again later.',
    inviteOnlyTitle: 'Private beta: invitation required',
    inviteOnlyNote: 'Creating an account requires a personal invitation from the QeyNox team. Use the e-mail address the invitation was sent to.',
    invitationLabel: 'Invitation code',
    invitationHint: 'The code from your invitation. It works once, only for the invited e-mail address, and expires.',
    invitationEnrollsHint: 'Your invitation enrolls the new workspace in the free beta.',
    invitationInvalid: 'This invitation cannot be used: it may be for another e-mail address, already used, revoked or expired. No account was created. Ask the QeyNox team for a new invitation.',
    conflict: 'The account could not be created. If you already have an account, sign in instead.',
    closedAtSubmit: 'Registration is closed. No account was created.',
    signIn: 'Sign in',
  },
  fr: {
    closedTitle: 'Les inscriptions sont fermées',
    closedBody: 'QeyNox n’accepte pas de nouveaux comptes pour le moment. Aucun compte ne peut être créé depuis cette page.',
    unavailableTitle: 'État des inscriptions indisponible',
    unavailableBody: 'Nous n’avons pas pu confirmer si les inscriptions sont ouvertes : le formulaire n’est donc pas affiché. Veuillez réessayer plus tard.',
    inviteOnlyTitle: 'Bêta privée : invitation requise',
    inviteOnlyNote: 'La création d’un compte nécessite une invitation personnelle de l’équipe QeyNox. Utilisez l’adresse e-mail à laquelle l’invitation a été envoyée.',
    invitationLabel: 'Code d’invitation',
    invitationHint: 'Le code de votre invitation. Il ne fonctionne qu’une fois, uniquement pour l’adresse e-mail invitée, et il expire.',
    invitationEnrollsHint: 'Votre invitation inscrit le nouvel espace de travail à la bêta gratuite.',
    invitationInvalid: 'Cette invitation ne peut pas être utilisée : elle concerne peut-être une autre adresse e-mail, a déjà servi, a été révoquée ou a expiré. Aucun compte n’a été créé. Demandez une nouvelle invitation à l’équipe QeyNox.',
    conflict: 'Le compte n’a pas pu être créé. Si vous avez déjà un compte, connectez-vous.',
    closedAtSubmit: 'Les inscriptions sont fermées. Aucun compte n’a été créé.',
    signIn: 'Se connecter',
  },
};
