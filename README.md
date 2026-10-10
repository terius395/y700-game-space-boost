# Y700 Perf Tuner

Module KernelSU/Magisk chỉnh giới hạn xung CPU/GPU cho 3 chế độ của Game Assistant trên
Lenovo Legion Y700: **Tiết kiệm pin**, **Cân bằng**, **Hiệu năng**. Bạn vẫn chọn chế độ trong
thanh bên Game Assistant như bình thường; module chỉ đổi mức xung mà mỗi chế độ được phép dùng.

Không cần Zygisk hay LSPosed, và không hook code nào: module thay bảng dữ liệu mà ZUI dùng để
chọn xung. Chi tiết kỹ thuật ở [docs/MODULE.md](docs/MODULE.md).

## Thiết bị

| Máy | Trạng thái |
|---|---|
| Legion Y700 Gen4 (TB322FC, ZUXOS 1.1.11.073) | Đã kiểm chứng, có số đo trong game |
| Máy ZUI khác có `com.zui.pp` (ví dụ Y700 Gen5) | Cài được, **chưa kiểm chứng**. WebUI đọc bảng tần số từ chính máy và hiện cảnh báo |

Cần root bằng KernelSU hoặc Magisk. Root kiểu "magica" không cần unlock bootloader cũng dùng được.

## Cài đặt

1. Cài `y700_perf_tuner-<version>.zip` trong KernelSU (hoặc Magisk), rồi reboot.
2. Mở module trong KernelSU để vào giao diện chỉnh (WebUI).
3. Trên máy khác Gen4: chọn mức xung rồi bấm **Lưu & áp dụng** để module sinh cấu hình từ
   file của máy bạn.

Cập nhật module: cài đè zip mới. Cài đặt đang dùng được giữ nguyên.

## Dùng

- Chọn tab chế độ, bấm một preset (Mặc định Lenovo / Mượt hơn / Tối đa / Tiết kiệm hơn) hoặc
  chọn từng mức xung tối đa. Xung tối thiểu nằm trong mục "Nâng cao".
- **Không giảm xung khi nóng**: giữ nguyên mức xung khi máy nóng lên. Máy sẽ nóng hơn nhiều;
  kernel vẫn tự hạ xung khi lõi chip quá 90–105°C.
- **Tăng tốc bộ nhớ** (chỉ ở Hiệu năng): giữ RAM/cache ở mức cao, giảm giật, tốn pin hơn.
- Bấm **Lưu & áp dụng**. Nếu đang chơi, **thoát hẳn game rồi mở lại**.
- **Khôi phục gốc**: trả toàn bộ về cấu hình Lenovo.

Cài đặt được lưu và tự áp dụng lại sau mỗi lần khởi động; không cần bấm gì thêm.

Không ép xung vượt phần cứng được: trên Gen4, CPU tối đa 3.53 / 4.32 GHz và GPU tối đa
1100 MHz, do firmware của Qualcomm quyết định. Danh sách trong WebUI đã gồm mọi mức chip hỗ trợ.

## Lưu ý

- Mức xung là **tuyệt đối**: "xung tối đa X" là trần X cho mọi game của chế độ đó, kể cả vài game
  nhẹ mà Lenovo vốn không giới hạn.
- Tăng tốc bộ nhớ vẫn giữ khi chuyển từ Hiệu năng sang Tiết kiệm pin, cho tới khi thoát game hoặc
  chuyển sang Cân bằng (do cách ZUI xử lý).
- Gỡ module sẽ tự trả cấu hình về gốc. Chỉ **tắt** (disable) module thì không: hãy bấm
  Khôi phục gốc trước khi tắt.
- Sau khi cập nhật firmware, WebUI báo "Cần lưu lại": kiểm tra các mức rồi bấm Lưu.

## Build từ mã nguồn

Cần Node.js ≥ 18, không có dependency.

```sh
npm test         # chạy test bộ sinh cấu hình
npm run build    # tạo dist/y700_perf_tuner-<version>.zip
npm run gen      # sinh thử cấu hình từ config/tuning.json và in thay đổi
```

| Đường dẫn | Nội dung |
|---|---|
| `module/` | Script module (`customize.sh`, `service.sh`, `bin/*.sh`) và WebUI (`webroot/`) |
| `lib/perfgen.js` | Bộ sinh cấu hình, dùng chung cho Node và WebUI |
| `config/tuning.json` | Cài đặt mặc định đóng vào zip |
| `stock/` | Cấu hình gốc của Gen4 (firmware 1.1.11.073), dùng để build và test |
| `tools/` | `build-module.js` (đóng zip), `gen.js` (sinh thử) |
| `tests/` | Test cho `lib/perfgen.js` |
| `docs/MODULE.md` | Tài liệu kỹ thuật |

Version module nằm trong `module/module.prop`. `stock/` là file của Lenovo lấy từ máy, chỉ dùng
cá nhân.

Tác giả: Terius.
