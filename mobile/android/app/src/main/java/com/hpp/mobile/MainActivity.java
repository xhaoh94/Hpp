package com.hpp.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
