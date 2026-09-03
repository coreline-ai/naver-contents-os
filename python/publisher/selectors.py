"""SmartEditor ONE selector registry — the single place to fix when Naver changes DOM
(docs/05: selectors.py 중앙 관리가 최고 재사용 자산). Every entry is a candidate list,
first match wins. These need periodic re-verification against the live editor;
the health check gates automation when any of them stops matching.
"""

from __future__ import annotations

EDITOR_URL_TEMPLATE = "https://blog.naver.com/{blog_id}/postwrite"
LOGIN_URL_MARKER = "nid.naver.com"

SMARTEDITOR_SELECTORS: dict[str, list[str]] = {
    # write screen loaded at all
    "editor_root": [".se-container", ".se-viewer", "#SE-canvas"],
    # help/draft popups that steal focus right after open
    "help_close": [
        "button.se-help-panel-close-button",
        ".se-popup-button-cancel",
        "button[data-name='close']",
    ],
    "title": [
        ".se-documentTitle .se-text-paragraph",
        ".se-title-text .se-text-paragraph",
        ".se-title-text",
    ],
    "body": [
        ".se-main-container .se-text-paragraph",
        ".se-main-container [contenteditable='true']",
        ".se-section-text .se-text-paragraph",
        ".se-component.se-text .se-text-paragraph",
    ],
    "image_button": [
        "button.se-image-toolbar-button",
        "button[data-name='image']",
        ".se-toolbar-item-image button",
    ],
    "publish_open_button": [
        "button.publish_btn__WEpYf",
        "button[class^='publish_btn__']",
        "button[class*=' publish_btn__']",
        "button[data-click-area='tpb.publish']",
        ".header__Uj5xL button.publish_btn",
    ],
    "tag_input": [
        "#tag-input",
        "input.tag_input",
        ".tag_area input",
    ],
    "draft_save_button": [
        "button.save_btn__bzc5B",
        "button[class^='save_btn__']",
        "button[class*=' save_btn__']",
        ".save_area button.save_btn",
        "button[data-click-area='tpb.save']",
    ],
    "draft_save_success": [
        "text=임시저장되었습니다",
        "text=저장되었습니다",
        "span[class^='autosave_message__'][class*='is_show__']",
        "[class*='save_complete']",
    ],
    # A persistent save-state/timestamp is intentionally separate from the
    # transient confirmation above. Both must be observed before a job closes.
    "draft_save_state": [
        "button[class^='save_count_btn__']",
        "[class*='saveStatus']",
        ".save_area [class*='time']",
        "button[data-click-area='tpb.save'] time",
        "[class*='saved_at']",
    ],
}

# Passive gates. Tag input is checked actively after opening the publish layer.
HEALTH_CHECKS: tuple[tuple[str, str], ...] = (
    ("editor_entry", "editor_root"),
    ("title_area", "title"),
    ("body_area", "body"),
    ("draft_save_button", "draft_save_button"),
)
