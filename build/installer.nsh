!macro customInit
  ; Hpp 0.1.0 accidentally packaged Gradle intermediates whose paths become
  ; too long when the old uninstaller moves them into its temporary folder.
  RMDir /r "$INSTDIR\resources\app\node_modules\@aparajita\capacitor-secure-storage\android\build"
  RMDir /r "$INSTDIR\resources\app\node_modules\@capacitor-mlkit\barcode-scanning\android\build"
  RMDir /r "$INSTDIR\resources\app\node_modules\@capacitor\android\capacitor\build"
  RMDir /r "$INSTDIR\resources\app\node_modules\@capacitor\app\android\build"
  RMDir /r "$INSTDIR\resources\app\node_modules\@capacitor\camera\android\build"
  ClearErrors
!macroend
