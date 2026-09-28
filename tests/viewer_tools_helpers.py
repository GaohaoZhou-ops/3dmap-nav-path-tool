def open_viewer_tools(page):
    trigger = page.get_by_role("button", name="视图工具", exact=True)
    if trigger.count() and trigger.get_attribute("aria-expanded") != "true":
        trigger.click()


def viewer_tool(page, name, exact=True):
    open_viewer_tools(page)
    return page.get_by_role("button", name=name, exact=exact)
