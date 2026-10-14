from colorlab.models import Region


def test_machine_selected_region_is_explicit_and_not_human_confirmed():
    region = Region.model_validate({"id": "live-auto-1", "label": "Machine-detected live sample", "order": 0, "mode": "bands", "polygon": [[.1,.1],[.5,.1],[.5,.5],[.1,.5]], "exclusions": [], "background": None, "layers": None, "direction": "horizontal", "operatorConfirmed": False, "selectionMethod": "autoDetected"})
    assert region.selectionMethod == "autoDetected"
    assert region.operatorConfirmed is False
