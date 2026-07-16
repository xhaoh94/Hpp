import { describe, expect, it } from "vitest";
import { getImageErrorMessage, isImageSelectionCancelled } from "./images";

describe("mobile image errors", () => {
  it("treats photo picker cancellation as a silent action", () => {
    const error = Object.assign(new Error("User cancelled photos app"), { code: "OS-PLUG-CAMR-0020" });

    expect(isImageSelectionCancelled(error)).toBe(true);
    expect(getImageErrorMessage(error)).toBe("");
  });

  it("translates permission failures", () => {
    const error = Object.assign(new Error("Camera permission denied"), { code: "OS-PLUG-CAMR-0003" });

    expect(isImageSelectionCancelled(error)).toBe(false);
    expect(getImageErrorMessage(error)).toBe("没有相机或相册访问权限，请在系统设置中允许 Hpp 访问。");
  });

  it("translates image size failures", () => {
    expect(getImageErrorMessage(new Error("Image is still larger than 2 MB after compression.")))
      .toBe("图片压缩后仍超过 2 MB，请选择尺寸更小的图片。");
  });
});
