# ورودی و خروجی نمونه

`reference-target-template.json` فقط قالب است؛ سفید و مشاهده‌گر آن پیش‌فرض و تأییدنشده‌اند. هیچ مقدار رنگ واقعی در آن نیست و نباید به‌عنوان کارت معتبر پذیرفته شود. منبع و نسخه و مقادیر وصله‌ها باید از مرجع واقعی وارد شوند. هر وصله شناسهٔ فیزیکی، `values` سه‌تایی، `split` برابر `train` یا `holdout` و وضعیت `neutral` دارد. تقسیم آموزش/ارزیابی پس از دیدن خطا نباید برای پنهان‌کردن خطا تغییر کند.

`replay-srgb.json` و `replay-p3.json` و CSV متناظر هنگام آزمون از API واقعی و عکس‌های ورودی تولید می‌شوند. اعداد آن‌ها محاسبهٔ پیکسل عکس هستند، نه اندازه‌گیری فیزیکی پارچه. عکس و ROI و ICC و دامنهٔ رنگ در گزارش ثبت می‌شوند. `displayDriveRgb` و `instrumentDeltaE00` در بازپخش `null` می‌مانند. این خروجی‌ها دادهٔ آزمایشی‌اند و نباید به‌عنوان رنگ تأییدشدهٔ سایت منتشر شوند.

ناحیه‌های مرجع انتخاب AI و قابل ویرایش هستند؛ `humanConfirmed:false` تا وقتی اپراتور واقعی آن‌ها را بررسی کند. اجرای آزمون تشخیص مرز روی این تصاویر به معنای عبور از معیار annotation انسانی نیست.

برای بازتولید خروجی‌ها و schema از API محلی درون‌فرایند:

```bash
/home/betoche/go/GOLD_PROJECT/GoLang_P/AryaDeco-Color-Lab/.venv/bin/python /home/betoche/go/GOLD_PROJECT/GoLang_P/AryaDeco-Color-Lab/tools/generate_delivery.py --write
/home/betoche/go/GOLD_PROJECT/GoLang_P/AryaDeco-Color-Lab/.venv/bin/python /home/betoche/go/GOLD_PROJECT/GoLang_P/AryaDeco-Color-Lab/tools/check_artifacts.py
```

شناسه‌ها و زمان تولید خروجی در هر اجرا تغییر می‌کنند؛ تصویر اصلی و hash ثابت می‌مانند. ابزار فقط فایل‌های `examples/replay-*` و schema محلی را بازنویسی می‌کند. هیچ شبکهٔ پروداکشن یا مقادیر سنجش فیزیکی در آن نیست. ROIهای JSON از annotationهای قابل ویرایش `references` خوانده می‌شوند. بخش ناقص انتهایی کالیته در annotation جدا ثبت شده و به‌عنوان یازدهمین/دوازدهمین نمونهٔ کامل ساخته نمی‌شود.
