package main

import (
    "github.com/hexops/vecty/elem"
    "github.com/hexops/vecty"
	"github.com/gopherjs/gopherjs/js"
)
type MyComponent struct {
	vecty.Core
}

func (mc *MyComponent) Render() vecty.ComponentOrHTML {
	return elem.Div(vecty.Markup(
        vecty.Attribute("id", "map"),
        vecty.Style("width", "100%"),
        vecty.Style("height", "500px"),
    ))
}

func main() {
    js.Global.Call("addEventListener", "DOMContentLoaded", func() {
        go func() {
            // Render the Vecty component which includes the map div
            

            // Initialize the Leaflet map
            leaflet := js.Global.Get("L")
            osm_map := leaflet.Call("map", "map")
            osm_map.Call("setView", []interface{}{51.505, -0.09}, 13)

            // Add a tile layer to the map using OpenStreetMap tiles
            tileLayer := leaflet.Call("tileLayer",
                "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                osm_map,
                osm_map,  // Your previous code had redundant 'map' arguments which could cause issues.
            )
            tileLayer.Call("addTo", osm_map)
			vecty.RenderBody(&MyComponent{})
        }()
    })
}

