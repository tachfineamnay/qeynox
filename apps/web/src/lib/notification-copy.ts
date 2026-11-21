import type { Locale } from './copy';

/** MISSION A19 — notification inbox & preferences copy (EN/FR). */
export function notificationCopy(lang: Locale) {
  if (lang === 'fr') {
    return {
      title: 'Notifications',
      intro: 'Revues en attente, échecs d’exécution et résultats livrés pour cet espace de travail.',
      filterAll: 'Toutes',
      filterUnread: 'Non lues',
      markAllRead: 'Tout marquer comme lu',
      markRead: 'Marquer comme lue',
      openMission: 'Ouvrir la mission',
      unread: 'non lue(s)',
      empty: 'Aucune notification',
      emptyUnread: 'Aucune notification non lue.',
      emptyAll: 'Vous serez notifié ici lorsqu’une revue, un échec ou un résultat surviendra.',
      preferencesTitle: 'Préférences e-mail',
      preferencesNote: 'Ces préférences contrôlent les e-mails de notification pour ce compte. La boîte de réception applicative enregistre toujours chaque événement ; les e-mails transactionnels (vérification, récupération, invitations) ne sont jamais désactivables.',
      approvalsLabel: 'Revues et approbations',
      approvalsNote: 'Un résultat est prêt et attend votre revue.',
      failuresLabel: 'Échecs d’exécution',
      failuresNote: 'Une étape s’est arrêtée ; rien n’est marqué comme livré.',
      resultsLabel: 'Résultats livrés',
      resultsNote: 'Le livrable revu a été publié.',
      saveFailed: 'La préférence n’a pas pu être enregistrée.',
      email: 'E-mail',
      failed: 'Les notifications ne sont pas disponibles pour le moment.',
    };
  }
  return {
    title: 'Notifications',
    intro: 'Reviews waiting on you, execution failures and delivered results for this workspace.',
    filterAll: 'All',
    filterUnread: 'Unread',
    markAllRead: 'Mark all as read',
    markRead: 'Mark as read',
    openMission: 'Open mission',
    unread: 'unread',
    empty: 'No notifications',
    emptyUnread: 'No unread notifications.',
    emptyAll: 'You will be notified here when a review, a failure or a result happens.',
    preferencesTitle: 'E-mail preferences',
    preferencesNote: 'These preferences control notification e-mails for this account. The in-app inbox always records every event; transactional e-mails (verification, recovery, invitations) are never opt-out-able.',
    approvalsLabel: 'Reviews and approvals',
    approvalsNote: 'A result is ready and waiting for your review.',
    failuresLabel: 'Execution failures',
    failuresNote: 'A step stopped; nothing is marked as delivered.',
    resultsLabel: 'Delivered results',
    resultsNote: 'The reviewed deliverable has been released.',
    saveFailed: 'The preference could not be saved.',
    email: 'E-mail',
    failed: 'Notifications are unavailable right now.',
  };
}
