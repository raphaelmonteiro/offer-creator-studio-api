export const IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT = `Classify the user's image editing/generation intent.

Return ONLY JSON:
{
  "category": "new_full_image" | "targeted_edit" | "style_variation" | "add_layer_element" | "replace_layer_element" | "layout_change" | "text_change",
  "confidence": 0.0-1.0,
  "reason": "short non-sensitive explanation"
}

Definitions:
- new_full_image: create a new complete image/template/background from scratch.
- targeted_edit: make a small visual edit to the existing image while preserving everything else.
- style_variation: create a new visual variation or apply a style/reference to the image.
- add_layer_element: add a separate decorative/object element to a layered template.
- replace_layer_element: replace one object/element in a layered template.
- layout_change: move, resize, reorder, align, or adjust positions without changing image content.
- text_change: change copy, labels, price, title, typography, or other editable text without changing image content.

Prefer text_change/layout_change when the user asks only to edit text or positions. Prefer add_layer_element/replace_layer_element for isolated objects in a layered template. If uncertain, use targeted_edit for existing images and new_full_image for new requests.`;
