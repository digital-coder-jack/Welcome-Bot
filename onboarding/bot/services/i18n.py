"""
Forge Guardian i18n — multi-language string catalog.

Usage:
    t = bot.i18n.t          # translator
    lang = await bot.guardian_store.language(guild_id)
    title = t(lang, "review.title")
    body  = t(lang, "warn.l1.title", server=guild.name)

Missing keys / languages transparently fall back to English so a partial
translation can never crash the bot. Add a language by extending LOCALES.
"""
from __future__ import annotations

from bot.core.logging import get_logger

log = get_logger("i18n")

SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Español",
    "fr": "Français",
    "de": "Deutsch",
    "hi": "हिन्दी",
    "pt": "Português",
}

LOCALES: dict[str, dict[str, str]] = {
    # ═════════════════════════════════ ENGLISH (source of truth)
    "en": {
        # welcome
        "welcome.title": "⚡ Welcome to {server}!",
        "welcome.desc": "Hey {mention}, welcome aboard! 🎉\nYou are our **{ordinal}** member.\n\nExplore the buttons below to get started. 🚀",
        # warnings
        "warn.l1.title": "💬 Friendly Reminder — {server}",
        "warn.l1.footer": "Level 1 of 3 • No action taken",
        "warn.l2.title": "⚠️ Official Warning — {server}",
        "warn.l2.footer": "Level 2 of 3 • The next violation triggers a moderator review",
        "warn.l3.footer": "Level 3 of 3 • Sent to moderator review",
        "warn.rule": "📜 Rule violated",
        "warn.what": "🔎 What happened",
        "warn.avoid": "✅ How to avoid this",
        "warn.previous": "🗂 Previous warnings",
        "warn.next": "⏭ What happens next",
        "warn.l2.next": "One more violation will send your case to the moderation team for review. Possible outcomes include timeout, kick or ban.",
        # review / security alert
        "review.title": "🚨 Moderation Review Required",
        "review.desc": "**{member}** has reached the review threshold. **No action has been taken yet** — an authorized moderator must approve an action below.",
        "review.member": "👤 Member",
        "review.user_id": "🆔 User ID",
        "review.account_created": "📅 Account Created",
        "review.joined": "📥 Joined Server",
        "review.roles": "🎭 Current Roles",
        "review.warnings": "⚠️ Warning Count",
        "review.violation": "🚫 Violation Detected",
        "review.evidence": "🧾 Evidence Summary",
        "review.history": "🗂 Warning History",
        "review.timeline": "🕒 Violation Timeline",
        "review.confidence": "📈 Confidence",
        "review.recommended": "💡 Recommended Action",
        "review.risk": "📊 Risk Score",
        "review.footer": "Review #{id} • Only Administrators / Security Team may act",
        "review.no_permission": "🚫 You do not have permission to perform this moderation action.",
        "review.already_handled": "ℹ️ This review has already been handled by another moderator.",
        "review.claimed": "⏳ Another moderator is currently processing this review.",
        "review.resolved.warn": "⚠️ Final warning issued by {moderator}.",
        "review.resolved.timeout": "⏳ Member timed out by {moderator}.",
        "review.resolved.kick": "👢 Member kicked by {moderator}.",
        "review.resolved.ban": "🔨 Member banned by {moderator}.",
        "review.resolved.dismiss": "❌ Review dismissed by {moderator} — no action taken.",
        "review.action_failed": "⚠️ The action could not be executed (missing permissions or the member left). The review was returned to pending.",
        "review.evidence_title": "📄 Full Evidence — Review #{id}",
        # member notifications
        "notice.warn.final": "⚠️ **Final Warning from {server}**\nA moderator reviewed your case and issued a final warning.\n**Reason:** {reason}\nAny further violation will result in removal.",
        "notice.timeout": "⏳ **You have been timed out in {server}**\n**Reason:** {reason}\n**Duration:** {duration} minutes.",
        "notice.kick": "👢 **You have been removed from {server}**\nA moderator reviewed your case and approved a kick.\n**Reason:** {reason}\n\n**Your warning history:**\n{history}",
        "notice.ban": "🔨 **You have been banned from {server}**\nA moderator reviewed your case and approved a ban.\n**Reason:** {reason}\n\n**Your warning history:**\n{history}",
        # mod logs
        "log.member_join": "📥 Member Joined",
        "log.member_leave": "📤 Member Left",
        "log.kick": "👢 Member Kicked",
        "log.ban": "🔨 Member Banned",
        "log.unban": "🕊 Member Unbanned",
        "log.timeout": "⏳ Timeout Applied",
        "log.timeout_removed": "⏱ Timeout Removed",
        "log.warning": "⚠️ Warning Issued",
        "log.message_delete": "🗑 Message Deleted",
        "log.role_add": "➕ Role Added",
        "log.role_remove": "➖ Role Removed",
        "log.security": "🛡 Security Alert",
        "log.field.user": "👤 User",
        "log.field.moderator": "🛠 Moderator",
        "log.field.reason": "📝 Reason",
        "log.field.channel": "📺 Channel",
        "log.field.evidence": "🧾 Evidence",
        # buttons
        "btn.final_warning": "⚠️ Issue Final Warning",
        "btn.timeout": "⏳ Timeout",
        "btn.kick": "👢 Kick Member",
        "btn.ban": "🔨 Ban Member",
        "btn.dismiss": "❌ Dismiss",
        "btn.evidence": "📄 View Evidence",
    },
    # ═════════════════════════════════ SPANISH
    "es": {
        "welcome.title": "⚡ ¡Bienvenido a {server}!",
        "welcome.desc": "¡Hola {mention}, bienvenido! 🎉\nEres nuestro miembro **{ordinal}**.\n\nExplora los botones de abajo para empezar. 🚀",
        "warn.l1.title": "💬 Recordatorio Amistoso — {server}",
        "warn.l1.footer": "Nivel 1 de 3 • Sin sanción",
        "warn.l2.title": "⚠️ Advertencia Oficial — {server}",
        "warn.l2.footer": "Nivel 2 de 3 • La próxima infracción irá a revisión de moderadores",
        "warn.l3.footer": "Nivel 3 de 3 • Enviado a revisión de moderadores",
        "warn.rule": "📜 Regla violada",
        "warn.what": "🔎 Qué ocurrió",
        "warn.avoid": "✅ Cómo evitarlo",
        "warn.previous": "🗂 Advertencias anteriores",
        "warn.next": "⏭ Qué sigue",
        "warn.l2.next": "Una infracción más enviará tu caso al equipo de moderación. Los resultados posibles incluyen aislamiento, expulsión o baneo.",
        "review.title": "🚨 Se Requiere Revisión de Moderación",
        "review.desc": "**{member}** ha alcanzado el umbral de revisión. **Aún no se ha tomado ninguna acción** — un moderador autorizado debe aprobar una acción abajo.",
        "review.member": "👤 Miembro",
        "review.user_id": "🆔 ID de Usuario",
        "review.account_created": "📅 Cuenta Creada",
        "review.joined": "📥 Se Unió",
        "review.roles": "🎭 Roles Actuales",
        "review.warnings": "⚠️ Advertencias",
        "review.violation": "🚫 Infracción Detectada",
        "review.evidence": "🧾 Resumen de Evidencia",
        "review.history": "🗂 Historial de Advertencias",
        "review.timeline": "🕒 Cronología de Infracciones",
        "review.confidence": "📈 Confianza",
        "review.recommended": "💡 Acción Recomendada",
        "review.risk": "📊 Puntuación de Riesgo",
        "review.footer": "Revisión #{id} • Solo Administradores / Equipo de Seguridad",
        "review.no_permission": "🚫 No tienes permiso para realizar esta acción de moderación.",
        "review.already_handled": "ℹ️ Esta revisión ya fue gestionada por otro moderador.",
        "review.claimed": "⏳ Otro moderador está procesando esta revisión.",
        "review.resolved.warn": "⚠️ Advertencia final emitida por {moderator}.",
        "review.resolved.timeout": "⏳ Miembro aislado por {moderator}.",
        "review.resolved.kick": "👢 Miembro expulsado por {moderator}.",
        "review.resolved.ban": "🔨 Miembro baneado por {moderator}.",
        "review.resolved.dismiss": "❌ Revisión descartada por {moderator} — sin acción.",
        "review.action_failed": "⚠️ No se pudo ejecutar la acción (faltan permisos o el miembro se fue). La revisión volvió a pendiente.",
        "review.evidence_title": "📄 Evidencia Completa — Revisión #{id}",
        "notice.warn.final": "⚠️ **Advertencia Final de {server}**\nUn moderador revisó tu caso y emitió una advertencia final.\n**Motivo:** {reason}\nCualquier otra infracción resultará en tu expulsión.",
        "notice.timeout": "⏳ **Has sido aislado en {server}**\n**Motivo:** {reason}\n**Duración:** {duration} minutos.",
        "notice.kick": "👢 **Has sido expulsado de {server}**\nUn moderador revisó tu caso y aprobó la expulsión.\n**Motivo:** {reason}\n\n**Tu historial:**\n{history}",
        "notice.ban": "🔨 **Has sido baneado de {server}**\nUn moderador revisó tu caso y aprobó el baneo.\n**Motivo:** {reason}\n\n**Tu historial:**\n{history}",
        "log.member_join": "📥 Miembro Se Unió",
        "log.member_leave": "📤 Miembro Se Fue",
        "log.kick": "👢 Miembro Expulsado",
        "log.ban": "🔨 Miembro Baneado",
        "log.unban": "🕊 Baneo Retirado",
        "log.timeout": "⏳ Aislamiento Aplicado",
        "log.timeout_removed": "⏱ Aislamiento Retirado",
        "log.warning": "⚠️ Advertencia Emitida",
        "log.message_delete": "🗑 Mensaje Eliminado",
        "log.role_add": "➕ Rol Añadido",
        "log.role_remove": "➖ Rol Retirado",
        "log.security": "🛡 Alerta de Seguridad",
        "log.field.user": "👤 Usuario",
        "log.field.moderator": "🛠 Moderador",
        "log.field.reason": "📝 Motivo",
        "log.field.channel": "📺 Canal",
        "log.field.evidence": "🧾 Evidencia",
        "btn.final_warning": "⚠️ Advertencia Final",
        "btn.timeout": "⏳ Aislar",
        "btn.kick": "👢 Expulsar",
        "btn.ban": "🔨 Banear",
        "btn.dismiss": "❌ Descartar",
        "btn.evidence": "📄 Ver Evidencia",
    },
    # ═════════════════════════════════ FRENCH
    "fr": {
        "welcome.title": "⚡ Bienvenue sur {server} !",
        "warn.l1.title": "💬 Rappel Amical — {server}",
        "warn.l1.footer": "Niveau 1 sur 3 • Aucune sanction",
        "warn.l2.title": "⚠️ Avertissement Officiel — {server}",
        "warn.l2.footer": "Niveau 2 sur 3 • La prochaine infraction ira en révision",
        "warn.l3.footer": "Niveau 3 sur 3 • Envoyé en révision des modérateurs",
        "review.title": "🚨 Révision de Modération Requise",
        "review.desc": "**{member}** a atteint le seuil de révision. **Aucune action n'a encore été prise** — un modérateur autorisé doit approuver une action ci-dessous.",
        "review.no_permission": "🚫 Vous n'avez pas la permission d'effectuer cette action de modération.",
        "review.already_handled": "ℹ️ Cette révision a déjà été traitée par un autre modérateur.",
        "review.claimed": "⏳ Un autre modérateur traite actuellement cette révision.",
        "notice.kick": "👢 **Vous avez été expulsé de {server}**\nUn modérateur a examiné votre cas et approuvé l'expulsion.\n**Raison :** {reason}\n\n**Votre historique :**\n{history}",
        "notice.ban": "🔨 **Vous avez été banni de {server}**\nUn modérateur a examiné votre cas et approuvé le bannissement.\n**Raison :** {reason}\n\n**Votre historique :**\n{history}",
        "log.member_join": "📥 Membre Arrivé",
        "log.member_leave": "📤 Membre Parti",
        "log.kick": "👢 Membre Expulsé",
        "log.ban": "🔨 Membre Banni",
        "btn.final_warning": "⚠️ Avertissement Final",
        "btn.timeout": "⏳ Exclusion Temporaire",
        "btn.kick": "👢 Expulser",
        "btn.ban": "🔨 Bannir",
        "btn.dismiss": "❌ Ignorer",
        "btn.evidence": "📄 Voir les Preuves",
    },
    # ═════════════════════════════════ GERMAN
    "de": {
        "welcome.title": "⚡ Willkommen auf {server}!",
        "warn.l1.title": "💬 Freundliche Erinnerung — {server}",
        "warn.l1.footer": "Stufe 1 von 3 • Keine Strafe",
        "warn.l2.title": "⚠️ Offizielle Verwarnung — {server}",
        "warn.l2.footer": "Stufe 2 von 3 • Der nächste Verstoß führt zur Moderatoren-Prüfung",
        "warn.l3.footer": "Stufe 3 von 3 • An Moderatoren-Prüfung gesendet",
        "review.title": "🚨 Moderations-Prüfung Erforderlich",
        "review.desc": "**{member}** hat die Prüfschwelle erreicht. **Es wurde noch keine Maßnahme ergriffen** — ein autorisierter Moderator muss unten eine Aktion genehmigen.",
        "review.no_permission": "🚫 Du hast keine Berechtigung für diese Moderationsaktion.",
        "review.already_handled": "ℹ️ Diese Prüfung wurde bereits von einem anderen Moderator bearbeitet.",
        "review.claimed": "⏳ Ein anderer Moderator bearbeitet diese Prüfung gerade.",
        "notice.kick": "👢 **Du wurdest von {server} entfernt**\nEin Moderator hat deinen Fall geprüft und den Kick genehmigt.\n**Grund:** {reason}\n\n**Deine Verwarnungen:**\n{history}",
        "notice.ban": "🔨 **Du wurdest von {server} gebannt**\nEin Moderator hat deinen Fall geprüft und den Bann genehmigt.\n**Grund:** {reason}\n\n**Deine Verwarnungen:**\n{history}",
        "log.member_join": "📥 Mitglied Beigetreten",
        "log.member_leave": "📤 Mitglied Gegangen",
        "log.kick": "👢 Mitglied Gekickt",
        "log.ban": "🔨 Mitglied Gebannt",
        "btn.final_warning": "⚠️ Letzte Verwarnung",
        "btn.timeout": "⏳ Timeout",
        "btn.kick": "👢 Kicken",
        "btn.ban": "🔨 Bannen",
        "btn.dismiss": "❌ Verwerfen",
        "btn.evidence": "📄 Beweise Ansehen",
    },
    # ═════════════════════════════════ HINDI
    "hi": {
        "welcome.title": "⚡ {server} में आपका स्वागत है!",
        "warn.l1.title": "💬 मैत्रीपूर्ण अनुस्मारक — {server}",
        "warn.l1.footer": "स्तर 1 / 3 • कोई कार्रवाई नहीं",
        "warn.l2.title": "⚠️ आधिकारिक चेतावनी — {server}",
        "warn.l2.footer": "स्तर 2 / 3 • अगला उल्लंघन मॉडरेटर समीक्षा में जाएगा",
        "warn.l3.footer": "स्तर 3 / 3 • मॉडरेटर समीक्षा में भेजा गया",
        "review.title": "🚨 मॉडरेशन समीक्षा आवश्यक",
        "review.desc": "**{member}** समीक्षा सीमा तक पहुंच गया है। **अभी तक कोई कार्रवाई नहीं की गई है** — एक अधिकृत मॉडरेटर को नीचे एक कार्रवाई स्वीकृत करनी होगी।",
        "review.no_permission": "🚫 आपके पास यह मॉडरेशन कार्रवाई करने की अनुमति नहीं है।",
        "review.already_handled": "ℹ️ इस समीक्षा को पहले ही किसी अन्य मॉडरेटर ने संभाल लिया है।",
        "review.claimed": "⏳ एक अन्य मॉडरेटर वर्तमान में इस समीक्षा को संसाधित कर रहा है।",
        "notice.kick": "👢 **आपको {server} से हटा दिया गया है**\nएक मॉडरेटर ने आपके मामले की समीक्षा की और किक स्वीकृत किया।\n**कारण:** {reason}\n\n**आपका चेतावनी इतिहास:**\n{history}",
        "notice.ban": "🔨 **आपको {server} से प्रतिबंधित कर दिया गया है**\nएक मॉडरेटर ने आपके मामले की समीक्षा की और बैन स्वीकृत किया।\n**कारण:** {reason}\n\n**आपका चेतावनी इतिहास:**\n{history}",
        "log.member_join": "📥 सदस्य शामिल हुआ",
        "log.member_leave": "📤 सदस्य चला गया",
        "log.kick": "👢 सदस्य निकाला गया",
        "log.ban": "🔨 सदस्य प्रतिबंधित",
        "btn.final_warning": "⚠️ अंतिम चेतावनी",
        "btn.timeout": "⏳ टाइमआउट",
        "btn.kick": "👢 निकालें",
        "btn.ban": "🔨 प्रतिबंधित करें",
        "btn.dismiss": "❌ खारिज करें",
        "btn.evidence": "📄 सबूत देखें",
    },
    # ═════════════════════════════════ PORTUGUESE
    "pt": {
        "welcome.title": "⚡ Bem-vindo ao {server}!",
        "warn.l1.title": "💬 Lembrete Amigável — {server}",
        "warn.l1.footer": "Nível 1 de 3 • Nenhuma ação tomada",
        "warn.l2.title": "⚠️ Advertência Oficial — {server}",
        "warn.l2.footer": "Nível 2 de 3 • A próxima violação irá para revisão dos moderadores",
        "warn.l3.footer": "Nível 3 de 3 • Enviado para revisão dos moderadores",
        "review.title": "🚨 Revisão de Moderação Necessária",
        "review.desc": "**{member}** atingiu o limite de revisão. **Nenhuma ação foi tomada ainda** — um moderador autorizado deve aprovar uma ação abaixo.",
        "review.no_permission": "🚫 Você não tem permissão para executar esta ação de moderação.",
        "review.already_handled": "ℹ️ Esta revisão já foi tratada por outro moderador.",
        "review.claimed": "⏳ Outro moderador está processando esta revisão.",
        "notice.kick": "👢 **Você foi removido de {server}**\nUm moderador revisou seu caso e aprovou a expulsão.\n**Motivo:** {reason}\n\n**Seu histórico:**\n{history}",
        "notice.ban": "🔨 **Você foi banido de {server}**\nUm moderador revisou seu caso e aprovou o banimento.\n**Motivo:** {reason}\n\n**Seu histórico:**\n{history}",
        "log.member_join": "📥 Membro Entrou",
        "log.member_leave": "📤 Membro Saiu",
        "log.kick": "👢 Membro Expulso",
        "log.ban": "🔨 Membro Banido",
        "btn.final_warning": "⚠️ Advertência Final",
        "btn.timeout": "⏳ Castigo",
        "btn.kick": "👢 Expulsar",
        "btn.ban": "🔨 Banir",
        "btn.dismiss": "❌ Descartar",
        "btn.evidence": "📄 Ver Evidências",
    },
}


class I18n:
    """Tiny translator with English fallback and safe formatting."""

    def t(self, lang: str, key: str, **kwargs) -> str:
        catalog = LOCALES.get(lang or "en", {})
        text = catalog.get(key) or LOCALES["en"].get(key) or key
        if kwargs:
            try:
                return text.format(**kwargs)
            except (KeyError, IndexError):
                log.warning("i18n format failed: %s (%s)", key, lang)
                return text
        return text

    @staticmethod
    def languages() -> dict[str, str]:
        return dict(SUPPORTED_LANGUAGES)
